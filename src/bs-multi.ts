// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from './bs-mem.js';
import { BsPeer } from './bs-peer.js';
import { PeerSocketMock } from './peer-socket-mock.js';

import type {
  BlobProperties,
  Bs,
  DownloadBlobOptions,
  ListBlobsOptions,
  ListBlobsResult,
} from './bs.js';
// ...........................................................................
/**
 * Type representing a Bs instance along with its capabilities and priority.
 */
export type BsMultiBs = {
  bs: Bs;
  id?: string;
  priority: number;
  read: boolean;
  write: boolean;
};

// ...........................................................................
/**
 * How long ONE source may take to answer a read while another source could
 * still be asked.
 *
 * Every read here walks the readables in priority order and only skips a
 * source it can SEE is gone (`_isClosed`). A source that is still open and
 * simply never answers therefore blocked the whole cascade for its full
 * request timeout — and a blob read is on the restore path, so the cost landed
 * on a user's files rather than on a diagnostic.
 *
 * Traced in `@rljson/fs-agent`: a node fetched a peer's tree in 4 s, started
 * the restore, and the restore timed out at 15 s because the blob fetch was
 * waiting on a cut peer. The re-created file arrived only when the window was
 * widened to 120 s. `@rljson/io` carries the same fix for its row reads.
 *
 * **The bound applies only while a FALLBACK exists.** The last readable is
 * never bounded, because there is nobody else to ask — so a cloud store, which
 * the hub deliberately places last, keeps exactly the behaviour it had. A
 * source that is abandoned is recorded like any other failure, so a read that
 * genuinely cannot be served still reports that rather than a false absence.
 */
export const BLOB_SOURCE_TIMEOUT_MS = 2_000;

/**
 * Multi-tier Bs implementation that combines multiple underlying Bs instances
 * with different capabilities (read, write) and priorities.
 *
 * Pattern: Local cache + remote server fallback
 * - Lower priority number = checked first
 * - Reads from highest priority readable, with hot-swapping to cache
 * - Writes to all writable instances in parallel
 */
export class BsMulti implements Bs {
  constructor(private _stores: Array<BsMultiBs>) {}

  // ...........................................................................
  /**
   * Initializes the BsMulti by assigning IDs to all underlying Bs instances.
   * All underlying Bs instances must already be initialized.
   */
  async init(): Promise<void> {
    for (let idx = 0; idx < this._stores.length; idx++) {
      this._stores[idx] = { ...this._stores[idx], id: `bs-${idx}` };
    }
    return Promise.resolve();
  }

  // ...........................................................................
  /**
   * Checks whether a Bs instance is a known-closed peer connection. Only
   * instances exposing an `isOpen` flag (e.g. BsPeer) can be closed;
   * instances without one (e.g. BsMem) are always treated as open.
   * @param bs - The Bs instance to check
   * @returns True if the instance exposes `isOpen === false`
   */
  /**
   * Whether any source after `index` could still answer.
   * @param index - Position of the source being asked.
   * @returns True when a later, non-closed readable exists.
   */
  private _hasFallback(index: number): boolean {
    return this.readables
      .slice(index + 1)
      .some((later) => !this._isClosed(later.bs));
  }

  /**
   * Bounds one source's answer so the cascade can move on to the next.
   *
   * Only applied when a fallback exists — see {@link BLOB_SOURCE_TIMEOUT_MS}.
   * The rejection is caught by the caller's `try`, which records it and
   * continues, so an abandoned source behaves exactly like one that errored.
   *
   * A late answer is DISCARDED, and a late stream is cancelled: abandoning a
   * `ReadableStream` without cancelling it leaves the source pushing bytes
   * nobody will read.
   * @param work - The source's pending answer.
   * @param index - Position of the source, for the fallback check.
   * @param what - Operation name, for the message.
   * @returns The answer, or a rejection once the bound passes.
   */
  private _bounded<T>(work: Promise<T>, index: number, what: string): Promise<T> {
    if (!this._hasFallback(index)) return work;
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void work.then(
            (late) => {
              const stream = late as { cancel?: () => unknown } | undefined;
              if (typeof stream?.cancel === 'function') void stream.cancel();
            },
            () => undefined,
          );
          reject(
            new Error(
              `BsMulti.${what}: source did not answer within ` +
                `${BLOB_SOURCE_TIMEOUT_MS}ms — asking the next`,
            ),
          );
        }, BLOB_SOURCE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private _isClosed(bs: Bs): boolean {
    return (bs as { isOpen?: boolean }).isOpen === false;
  }

  // ...........................................................................
  /**
   * Stores a blob in all writable Bs instances in parallel.
   * @param content - The blob content to store
   * @returns Promise resolving to blob properties from the first successful write
   */
  async setBlob(
    content: Buffer | string | ReadableStream<Uint8Array>,
  ): Promise<BlobProperties> {
    if (this.writables.length === 0) {
      throw new Error('No writable Bs available');
    }

    // Write to all writables in parallel
    /* v8 ignore next -- @preserve */
    const writes = this.writables.map(({ bs }) => bs.setBlob(content));
    const results = await Promise.all(writes);

    // All should return the same blobId (content-addressable)
    return results[0];
  }

  // ...........................................................................
  /**
   * Retrieves a blob from the highest priority readable Bs instance.
   * Hot-swaps the blob to all writable instances for caching.
   * @param blobId - The blob identifier
   * @param options - Download options
   * @returns Promise resolving to blob content and properties
   */
  async getBlob(
    blobId: string,
    options?: DownloadBlobOptions,
  ): Promise<{ content: Buffer; properties: BlobProperties }> {
    if (this.readables.length === 0) {
      throw new Error('No readable Bs available');
    }

    let result: { content: Buffer; properties: BlobProperties } | undefined;
    let readFrom: string = '';
    const errors: Error[] = [];
    let allClosed = true;

    // Try readables in priority order
    for (let index = 0; index < this.readables.length; index++) {
      const readable = this.readables[index];
      if (this._isClosed(readable.bs)) {
        continue; // Skip known-closed peers instead of hanging on them
      }
      allClosed = false;
      try {
        result = await this._bounded(
          readable.bs.getBlob(blobId, options),
          index,
          'getBlob',
        );
        readFrom = readable.id ?? '';
        break; // Stop after first successful read
      } catch (e) {
        errors.push(e as Error);
        continue;
      }
    }

    if (!result) {
      if (allClosed) {
        // No member was ever queried — this is a topology failure, not a
        // verified absence, so it must not look like "Blob not found".
        throw new Error('All readable Bs instances are closed');
      }

      // Blob not found in any readable
      /* v8 ignore next -- @preserve */
      const notFoundErrors = errors.filter((err) =>
        err.message.includes('Blob not found'),
      );
      if (notFoundErrors.length === errors.length) {
        throw new Error(`Blob not found: ${blobId}`);
      } else {
        throw errors[0]; // Throw first non-"not found" error
      }
    }

    // Hot-swap: write blob to all writables (except source) for caching
    if (this.writables.length > 0) {
      /* v8 ignore start -- @preserve */
      const hotSwapWrites = this.writables
        .filter((writable) => writable.id !== readFrom)
        .map(({ bs }) => bs.setBlob(result!.content).catch(() => {})); // Ignore cache write errors
      /* v8 ignore stop -- @preserve */

      await Promise.all(hotSwapWrites);
    }

    return result;
  }

  // ...........................................................................
  /**
   * Retrieves a blob as a ReadableStream from the highest priority readable Bs instance.
   * @param blobId - The blob identifier
   * @returns Promise resolving to a ReadableStream
   */
  async getBlobStream(blobId: string): Promise<ReadableStream<Uint8Array>> {
    if (this.readables.length === 0) {
      throw new Error('No readable Bs available');
    }

    const errors: Error[] = [];
    let allClosed = true;

    // Try readables in priority order
    for (let index = 0; index < this.readables.length; index++) {
      const readable = this.readables[index];
      if (this._isClosed(readable.bs)) {
        continue; // Skip known-closed peers instead of hanging on them
      }
      allClosed = false;
      try {
        return await this._bounded(
          readable.bs.getBlobStream(blobId),
          index,
          'getBlobStream',
        );
      } catch (e) {
        errors.push(e as Error);
        continue;
      }
    }

    if (allClosed) {
      throw new Error('All readable Bs instances are closed');
    }

    // Blob not found in any readable
    /* v8 ignore next -- @preserve */
    const notFoundErrors = errors.filter((err) =>
      err.message.includes('Blob not found'),
    );
    if (notFoundErrors.length === errors.length) {
      throw new Error(`Blob not found: ${blobId}`);
    } else {
      throw errors[0];
    }
  }

  // ...........................................................................
  /**
   * Deletes a blob from all writable Bs instances in parallel.
   * @param blobId - The blob identifier
   */
  async deleteBlob(blobId: string): Promise<void> {
    if (this.writables.length === 0) {
      throw new Error('No writable Bs available');
    }

    // Delete from all writables in parallel
    /* v8 ignore next -- @preserve */
    const deletes = this.writables.map(({ bs }) => bs.deleteBlob(blobId));
    await Promise.all(deletes);
  }

  // ...........................................................................
  /**
   * Checks if a blob exists in any readable Bs instance.
   * @param blobId - The blob identifier
   * @returns Promise resolving to true if blob exists in any readable
   */
  async blobExists(blobId: string): Promise<boolean> {
    if (this.readables.length === 0) {
      throw new Error('No readable Bs available');
    }

    // Check readables in priority order
    let allClosed = true;
    for (let index = 0; index < this.readables.length; index++) {
      const readable = this.readables[index];
      if (this._isClosed(readable.bs)) {
        continue; // Skip known-closed peers instead of hanging on them
      }
      allClosed = false;
      try {
        const exists = await this._bounded(
          readable.bs.blobExists(blobId),
          index,
          'blobExists',
        );
        if (exists) {
          return true;
        }
      } catch {
        continue;
      }
    }

    if (allClosed) {
      // No member was ever queried — this is a topology failure, so
      // returning `false` (a verified absence) would be misleading.
      throw new Error('All readable Bs instances are closed');
    }

    return false;
  }

  // ...........................................................................
  /**
   * Gets blob properties from the highest priority readable Bs instance.
   * @param blobId - The blob identifier
   * @returns Promise resolving to blob properties
   */
  async getBlobProperties(blobId: string): Promise<BlobProperties> {
    if (this.readables.length === 0) {
      throw new Error('No readable Bs available');
    }

    const errors: Error[] = [];
    let allClosed = true;

    // Try readables in priority order
    for (let index = 0; index < this.readables.length; index++) {
      const readable = this.readables[index];
      if (this._isClosed(readable.bs)) {
        continue; // Skip known-closed peers instead of hanging on them
      }
      allClosed = false;
      try {
        return await this._bounded(
          readable.bs.getBlobProperties(blobId),
          index,
          'getBlobProperties',
        );
      } catch (e) {
        errors.push(e as Error);
        continue;
      }
    }

    if (allClosed) {
      throw new Error('All readable Bs instances are closed');
    }

    // Blob not found in any readable
    /* v8 ignore next -- @preserve */
    const notFoundErrors = errors.filter((err) =>
      err.message.includes('Blob not found'),
    );
    if (notFoundErrors.length === errors.length) {
      throw new Error(`Blob not found: ${blobId}`);
    } else {
      throw errors[0];
    }
  }

  // ...........................................................................
  /**
   * Lists blobs by merging results from all readable Bs instances.
   * Deduplicates by blobId (content-addressable).
   * @param options - Listing options
   * @returns Promise resolving to list of blobs
   */
  async listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult> {
    if (this.readables.length === 0) {
      throw new Error('No readable Bs available');
    }

    const blobMap = new Map<string, BlobProperties>();
    let allClosed = true;

    // Collect ALL blobs from all readables (no pagination during collection)
    for (const readable of this.readables) {
      if (this._isClosed(readable.bs)) {
        continue; // Skip known-closed peers instead of hanging on them
      }
      allClosed = false;
      try {
        let continuationToken: string | undefined;
        do {
          const result = await readable.bs.listBlobs({
            prefix: options?.prefix, // Apply prefix filter during collection
            continuationToken,
            maxResults: 1000, // Fetch in chunks from each store
          });

          for (const blob of result.blobs) {
            if (!blobMap.has(blob.blobId)) {
              blobMap.set(blob.blobId, blob);
            }
          }

          continuationToken = result.continuationToken;
        } while (continuationToken); // Paginate through each store
      } catch {
        continue; // Skip stores that error
      }
    }

    if (allClosed) {
      // No member was ever queried — this is a topology failure, not an
      // empty inventory, so it must not silently look like "no blobs".
      throw new Error('All readable Bs instances are closed');
    }

    // Now apply pagination to merged results
    const blobs = Array.from(blobMap.values());

    // Sort for consistent ordering
    /* v8 ignore next -- @preserve */
    blobs.sort((a, b) => a.blobId.localeCompare(b.blobId));

    // Handle pagination
    const maxResults = options?.maxResults ?? blobs.length;
    let startIndex = 0;

    if (options?.continuationToken) {
      /* v8 ignore next -- @preserve */
      const tokenIndex = blobs.findIndex(
        (blob) => blob.blobId === options.continuationToken,
      );
      startIndex = tokenIndex === -1 ? 0 : tokenIndex + 1;
    }

    const endIndex = Math.min(startIndex + maxResults, blobs.length);
    const pageBlobs = blobs.slice(startIndex, endIndex);

    const continuationToken =
      endIndex < blobs.length
        ? pageBlobs[pageBlobs.length - 1]?.blobId
        : undefined;

    return {
      blobs: pageBlobs,
      continuationToken,
    };
  }

  // ...........................................................................
  /**
   * Generates a signed URL from the highest priority readable Bs instance.
   * @param blobId - The blob identifier
   * @param expiresIn - Expiration time in seconds
   * @param permissions - Access permissions
   * @returns Promise resolving to signed URL
   */
  async generateSignedUrl(
    blobId: string,
    expiresIn: number,
    permissions: 'read' | 'delete' = 'read',
  ): Promise<string> {
    if (this.readables.length === 0) {
      throw new Error('No readable Bs available');
    }

    const errors: Error[] = [];
    let allClosed = true;

    // Try readables in priority order
    for (const readable of this.readables) {
      if (this._isClosed(readable.bs)) {
        continue; // Skip known-closed peers instead of hanging on them
      }
      allClosed = false;
      try {
        return await readable.bs.generateSignedUrl(
          blobId,
          expiresIn,
          permissions,
        );
      } catch (e) {
        errors.push(e as Error);
        continue;
      }
    }

    if (allClosed) {
      throw new Error('All readable Bs instances are closed');
    }

    // Blob not found in any readable
    /* v8 ignore next -- @preserve */
    const notFoundErrors = errors.filter((err) =>
      err.message.includes('Blob not found'),
    );
    if (notFoundErrors.length === errors.length) {
      throw new Error(`Blob not found: ${blobId}`);
    } else {
      throw errors[0];
    }
  }

  // ...........................................................................
  /**
   * Gets the list of underlying readable Bs instances, sorted by priority.
   */
  get readables(): Array<BsMultiBs> {
    /* v8 ignore next -- @preserve */
    return this._stores
      .filter((store) => store.read)
      .sort((a, b) => a.priority - b.priority);
  }

  // ...........................................................................
  /**
   * Gets the list of underlying writable Bs instances, sorted by priority.
   */
  get writables(): Array<BsMultiBs> {
    /* v8 ignore next -- @preserve */
    return this._stores
      .filter((store) => store.write)
      .sort((a, b) => a.priority - b.priority);
  }

  // ...........................................................................
  /**
   * Example: Local cache (BsMem) + Remote server (BsPeer)
   */
  static example = async (): Promise<BsMulti> => {
    // Remote server (simulated)
    const bsRemoteMem = new BsMem();
    const bsRemoteSocket = new PeerSocketMock(bsRemoteMem);
    const bsRemote = new BsPeer(bsRemoteSocket);
    await bsRemote.init();

    // Local cache
    const bsLocal = new BsMem();

    const stores: Array<BsMultiBs> = [
      { bs: bsLocal, priority: 0, read: true, write: true }, // Cache first
      { bs: bsRemote, priority: 1, read: true, write: false }, // Remote fallback
    ];

    const bsMulti = new BsMulti(stores);
    await bsMulti.init();

    return bsMulti;
  };
}
