// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import {
  BlobProperties,
  Bs,
  DownloadBlobOptions,
  ListBlobsOptions,
  ListBlobsResult,
} from './bs.ts';
import { Socket } from './socket.ts';

/**
 * Peer implementation of the Bs interface that communicates over a socket.
 * Allows remote access to a blob storage instance.
 */
export class BsPeer implements Bs {
  isOpen: boolean = false;

  constructor(private _socket: Socket) {}

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
   * Stores a blob from Buffer, string, or ReadableStream and returns properties.
   * @param content - The blob content to store
   * @returns Promise resolving to blob properties
   */
  setBlob(
    content: Buffer | string | ReadableStream<Uint8Array>,
  ): Promise<BlobProperties> {
    return new Promise((resolve, reject) => {
      // Convert ReadableStream to Buffer if needed
      if (content instanceof ReadableStream) {
        // For streams, we need to read all chunks first
        const reader = content.getReader();
        const chunks: Uint8Array[] = [];

        const readStream = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const totalLength = chunks.reduce(
              (sum, chunk) => sum + chunk.length,
              0,
            );
            const buffer = Buffer.concat(
              chunks.map((chunk) => Buffer.from(chunk)),
              totalLength,
            );

            // Now emit with the buffer
            this._socket.emit(
              'setBlob',
              buffer,
              (error: Error | null, result?: BlobProperties) => {
                if (error) reject(error);
                else resolve(result!);
              },
            );
          } catch (err) {
            /* v8 ignore next -- @preserve */
            reject(err);
          }
        };

        readStream();
      } else {
        // For Buffer or string, emit directly
        this._socket.emit(
          'setBlob',
          content,
          (error: Error | null, result?: BlobProperties) => {
            if (error) reject(error);
            else resolve(result!);
          },
        );
      }
    });
  }

  // ...........................................................................
  /**
   * Retrieves a blob by its ID as a Buffer.
   * @param blobId - The unique identifier of the blob
   * @param options - Download options
   * @returns Promise resolving to blob content and properties
   */
  getBlob(
    blobId: string,
    options?: DownloadBlobOptions,
  ): Promise<{ content: Buffer; properties: BlobProperties }> {
    return new Promise((resolve, reject) => {
      this._socket.emit(
        'getBlob',
        blobId,
        options,
        (
          error: Error | null,
          result?: { content: Buffer; properties: BlobProperties },
        ) => {
          if (error) reject(error);
          else resolve(result!);
        },
      );
    });
  }

  // ...........................................................................
  /**
   * Retrieves a blob by its ID as a ReadableStream.
   * @param blobId - The unique identifier of the blob
   * @returns Promise resolving to readable stream
   */
  getBlobStream(blobId: string): Promise<ReadableStream<Uint8Array>> {
    return new Promise((resolve, reject) => {
      this._socket.emit(
        'getBlobStream',
        blobId,
        (error: Error | null, result?: ReadableStream<Uint8Array>) => {
          if (error) reject(error);
          else resolve(result!);
        },
      );
    });
  }

  // ...........................................................................
  /**
   * Deletes a blob by its ID.
   * @param blobId - The unique identifier of the blob
   * @returns Promise that resolves when deletion is complete
   */
  deleteBlob(blobId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this._socket.emit('deleteBlob', blobId, (error: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  // ...........................................................................
  /**
   * Checks if a blob exists.
   * @param blobId - The unique identifier of the blob
   * @returns Promise resolving to true if blob exists
   */
  blobExists(blobId: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this._socket.emit(
        'blobExists',
        blobId,
        (error: Error | null, exists?: boolean) => {
          if (error) reject(error);
          else resolve(exists!);
        },
      );
    });
  }

  // ...........................................................................
  /**
   * Gets blob properties (size, createdAt) without retrieving content.
   * @param blobId - The unique identifier of the blob
   * @returns Promise resolving to blob properties
   */
  getBlobProperties(blobId: string): Promise<BlobProperties> {
    return new Promise((resolve, reject) => {
      this._socket.emit(
        'getBlobProperties',
        blobId,
        (error: Error | null, result?: BlobProperties) => {
          if (error) reject(error);
          else resolve(result!);
        },
      );
    });
  }

  // ...........................................................................
  /**
   * Lists all blobs with optional filtering and pagination.
   * @param options - Optional listing configuration
   * @returns Promise resolving to list of blobs
   */
  listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult> {
    return new Promise((resolve, reject) => {
      this._socket.emit(
        'listBlobs',
        options || {},
        (error: Error | null, result?: ListBlobsResult) => {
          if (error) reject(error);
          else resolve(result!);
        },
      );
    });
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
    return new Promise((resolve, reject) => {
      this._socket.emit(
        'generateSignedUrl',
        blobId,
        expiresIn,
        permissions,
        (error: Error | null, url?: string) => {
          if (error) reject(error);
          else resolve(url!);
        },
      );
    });
  }
}
