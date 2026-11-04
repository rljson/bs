// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import {
  readBlocks,
  streamBlocks,
  verifyBlock,
  writeBlocks,
} from './blob-blocks.ts';
import {
  BlobBlock,
  BlobProperties,
  Bs,
  DownloadBlobOptions,
  ListBlobsOptions,
  ListBlobsResult,
} from './bs.ts';
import { Socket } from './socket.ts';

/**
 * Constructor options for BsPeer.
 */
export interface BsPeerOptions {
  /**
   * Milliseconds to wait for a request ack before rejecting with a timeout
   * error. Defaults to 30_000. A non-positive value disables the timeout.
   */
  requestTimeoutMs?: number;
}

/**
 * Peer implementation of the Bs interface that communicates over a socket.
 * Allows remote access to a blob storage instance.
 *
 * Bytes cross the socket only as blocks, one block per message, so no message
 * carries more than `BLOCK_MAX_BYTES` whatever the blob's size. Reading a blob
 * asks for its block list first and then for its blocks; storing one sends
 * only the blocks the other side does not hold yet.
 */
export class BsPeer implements Bs {
  isOpen: boolean = false;

  private readonly _requestTimeoutMs: number;

  constructor(
    private _socket: Socket,
    options?: BsPeerOptions,
  ) {
    this._requestTimeoutMs = options?.requestTimeoutMs ?? 30_000;
  }

  // ...........................................................................
  /**
   * Wraps a promise with a timeout. If the promise does not settle within
   * `_requestTimeoutMs`, the returned promise rejects with a timeout error.
   * Clears the timer on settlement to avoid leaks and unhandled rejections.
   * @param promise - The promise to guard with a timeout
   * @param operation - The method name, used in the timeout error message
   * @returns A promise that rejects if `promise` does not settle in time
   */
  private _withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
    if (this._requestTimeoutMs <= 0) return promise;
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Timeout after ${this._requestTimeoutMs}ms on '${operation}'`,
          ),
        );
      }, this._requestTimeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timer!);
    });
  }

  // ...........................................................................
  /**
   * Returns a rejected promise with a "socket closed" error, used to fail
   * requests fast when `isOpen` is already known to be false instead of
   * emitting them and waiting on a timeout.
   * @returns A promise that rejects with a "socket closed" error
   */
  private _closedError<T>(): Promise<T> {
    return Promise.reject(new Error('BsPeer: socket closed'));
  }

  // ...........................................................................
  /**
   * Initializes the Peer connection.
   */
  async init(): Promise<void> {
    // Update isOpen on connect/disconnect
    this._socket.on('connect', () => {
      this.isOpen = true;
    });
    this._socket.on('disconnect', () => {
      this.isOpen = false;
    });

    // Connect the socket
    this._socket.connect();

    // Wait for the socket to connect before returning
    return new Promise<void>((resolve) => {
      /* v8 ignore else -- @preserve */
      if (this._socket.connected) {
        this.isOpen = true;
        resolve();
      } else {
        this._socket.on('connect', () => {
          resolve();
        });
      }
    });
  }

  // ...........................................................................
  /**
   * Closes the Peer connection.
   */
  async close(): Promise<void> {
    // Disconnect the socket and wait for it to complete
    if (!this._socket.connected) return;

    return new Promise<void>((resolve) => {
      this._socket.on('disconnect', () => {
        resolve();
      });
      this._socket.disconnect();
    });
  }

  // ...........................................................................
  /**
   * Returns a promise that resolves once the Peer connection is ready.
   */
  async isReady(): Promise<void> {
    if (!!this._socket && this._socket.connected === true) this.isOpen = true;
    else this.isOpen = false;

    return !!this.isOpen ? Promise.resolve() : Promise.reject();
  }

  // ...........................................................................
  /**
   * Sends one request and waits for its acknowledgement.
   * @param event - The request.
   * @param args - Its arguments.
   * @returns The result the other side acknowledged with.
   */
  private _request<T>(event: string, ...args: unknown[]): Promise<T> {
    if (!this.isOpen) return this._closedError();

    return this._withTimeout(
      new Promise<T>((resolve, reject) => {
        this._socket.emit(event, ...args, (error: Error | null, result?: T) => {
          if (error) reject(error);
          else resolve(result as T);
        });
      }),
      event,
    );
  }

  // ...........................................................................
  /**
   * Stores a blob from Buffer, string, or ReadableStream and returns
   * properties. Cuts the content into blocks here and sends only the blocks
   * the other side lacks, then the block list.
   * @param content - The blob content to store
   * @returns Promise resolving to blob properties
   */
  async setBlob(
    content: Buffer | string | ReadableStream<Uint8Array>,
  ): Promise<BlobProperties> {
    if (!this.isOpen) return this._closedError();

    const { blobId, blocks } = await writeBlocks(
      content,
      async ({ blockId }, bytes) => {
        if (!(await this.blockExists(blockId))) await this.setBlock(bytes);
      },
    );
    return this.setBlobBlocks(blobId, blocks);
  }

  // ...........................................................................
  /**
   * Retrieves a blob by its ID as a Buffer, assembled here from its blocks.
   * A range fetches only the blocks it touches.
   * @param blobId - The unique identifier of the blob
   * @param options - Download options
   * @returns Promise resolving to blob content and properties
   */
  async getBlob(
    blobId: string,
    options?: DownloadBlobOptions,
  ): Promise<{ content: Buffer; properties: BlobProperties }> {
    if (!this.isOpen) return this._closedError();

    const properties = await this.getBlobProperties(blobId);
    const blocks = await this.getBlobBlocks(blobId);
    const content = await readBlocks(
      blocks,
      (blockId) => this.getBlock(blockId),
      options?.range,
    );
    return { content, properties };
  }

  // ...........................................................................
  /**
   * Retrieves a blob by its ID as a ReadableStream, pulled one block at a
   * time.
   *
   * A stream cannot cross a socket in an acknowledgement — it arrives as `{}`
   * — so it is built on this side. The consumer's pace is the flow control:
   * the next block is asked for when the consumer reads on. The stream fails
   * at its end unless the bytes hash to `blobId`.
   * @param blobId - The unique identifier of the blob
   * @returns Promise resolving to readable stream
   */
  async getBlobStream(blobId: string): Promise<ReadableStream<Uint8Array>> {
    if (!this.isOpen) return this._closedError();

    // Asking for the block list first also fails fast on a missing blob —
    // before the caller is handed a stream that can only fail on its first
    // read.
    const blocks = await this.getBlobBlocks(blobId);
    return streamBlocks(blobId, blocks, (blockId) => this.getBlock(blockId));
  }

  // ...........................................................................
  /**
   * Deletes a blob by its ID.
   * @param blobId - The unique identifier of the blob
   * @returns Promise that resolves when deletion is complete
   */
  deleteBlob(blobId: string): Promise<void> {
    return this._request('deleteBlob', blobId);
  }

  // ...........................................................................
  /**
   * Checks if a blob exists.
   * @param blobId - The unique identifier of the blob
   * @returns Promise resolving to true if blob exists
   */
  blobExists(blobId: string): Promise<boolean> {
    return this._request('blobExists', blobId);
  }

  // ...........................................................................
  /**
   * Gets blob properties (size, createdAt) without retrieving content.
   * @param blobId - The unique identifier of the blob
   * @returns Promise resolving to blob properties
   */
  getBlobProperties(blobId: string): Promise<BlobProperties> {
    return this._request('getBlobProperties', blobId);
  }

  // ...........................................................................
  /**
   * Lists all blobs with optional filtering and pagination.
   * @param options - Optional listing configuration
   * @returns Promise resolving to list of blobs
   */
  listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult> {
    return this._request('listBlobs', options || {});
  }

  // ...........................................................................
  /**
   * Generates a signed URL for temporary blob access.
   * @param blobId - The unique identifier of the blob
   * @param expiresIn - Expiration time in seconds
   * @param permissions - Permissions for the URL
   * @returns Promise resolving to signed URL
   */
  generateSignedUrl(
    blobId: string,
    expiresIn: number,
    permissions?: 'read' | 'delete',
  ): Promise<string> {
    return this._request('generateSignedUrl', blobId, expiresIn, permissions);
  }

  // ...........................................................................
  /**
   * Gets the blocks a blob is made of.
   * @param blobId - The unique identifier of the blob
   * @returns Promise resolving to the blocks, in order
   */
  getBlobBlocks(blobId: string): Promise<BlobBlock[]> {
    return this._request('getBlobBlocks', blobId);
  }

  // ...........................................................................
  /**
   * Gets one block, and fails unless its bytes hash to `blockId`.
   * @param blockId - The unique identifier of the block
   * @returns Promise resolving to the block's bytes
   */
  async getBlock(blockId: string): Promise<Buffer> {
    const arrived = await this._request<Uint8Array>('getBlock', blockId);
    const bytes = Buffer.isBuffer(arrived) ? arrived : Buffer.from(arrived);
    verifyBlock(blockId, bytes);
    return bytes;
  }

  // ...........................................................................
  /**
   * Checks if a block exists.
   * @param blockId - The unique identifier of the block
   * @returns Promise resolving to true if the block exists
   */
  blockExists(blockId: string): Promise<boolean> {
    return this._request('blockExists', blockId);
  }

  // ...........................................................................
  /**
   * Stores one block.
   * @param content - The block's bytes
   * @returns Promise resolving to the stored block
   */
  setBlock(content: Buffer): Promise<BlobBlock> {
    return this._request('setBlock', content);
  }

  // ...........................................................................
  /**
   * Stores a blob made of blocks the other side holds.
   * @param blobId - The unique identifier of the blob
   * @param blocks - Its blocks, in order
   * @returns Promise resolving to blob properties
   */
  setBlobBlocks(blobId: string, blocks: BlobBlock[]): Promise<BlobProperties> {
    return this._request('setBlobBlocks', blobId, blocks);
  }
}
