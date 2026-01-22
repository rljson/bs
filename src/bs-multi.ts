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

    // Try readables in priority order
    for (const readable of this.readables) {
      try {
        result = await readable.bs.getBlob(blobId, options);
        readFrom = readable.id ?? '';
        break; // Stop after first successful read
      } catch (e) {
        errors.push(e as Error);
        continue;
      }
    }

    if (!result) {
      // Blob not found in any readable
      /* v8 ignore next 2 -- @preserve */
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
      /* v8 ignore next 3 -- @preserve */
      const hotSwapWrites = this.writables
        .filter((writable) => writable.id !== readFrom)
        .map(({ bs }) => bs.setBlob(result!.content).catch(() => {})); // Ignore cache write errors

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

    // Try readables in priority order
    for (const readable of this.readables) {
      try {
        return await readable.bs.getBlobStream(blobId);
      } catch (e) {
        errors.push(e as Error);
        continue;
      }
    }

    // Blob not found in any readable
    /* v8 ignore next 2 -- @preserve */
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
    for (const readable of this.readables) {
      try {
        const exists = await readable.bs.blobExists(blobId);
        if (exists) {
          return true;
        }
      } catch {
        continue;
      }
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

    // Try readables in priority order
    for (const readable of this.readables) {
      try {
        return await readable.bs.getBlobProperties(blobId);
      } catch (e) {
        errors.push(e as Error);
        continue;
      }
    }

    // Blob not found in any readable
    /* v8 ignore next 2 -- @preserve */
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

    // Collect ALL blobs from all readables (no pagination during collection)
    for (const readable of this.readables) {
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

    // Now apply pagination to merged results
    const blobs = Array.from(blobMap.values());

    // Sort for consistent ordering
    /* v8 ignore next -- @preserve */
    blobs.sort((a, b) => a.blobId.localeCompare(b.blobId));

    // Handle pagination
    const maxResults = options?.maxResults ?? blobs.length;
    let startIndex = 0;

    if (options?.continuationToken) {
      /* v8 ignore next 2 -- @preserve */
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

    // Try readables in priority order
    for (const readable of this.readables) {
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

    // Blob not found in any readable
    /* v8 ignore next 2 -- @preserve */
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
    /* v8 ignore next 2 -- @preserve */
    return this._stores
      .filter((store) => store.read)
      .sort((a, b) => a.priority - b.priority);
  }

  // ...........................................................................
  /**
   * Gets the list of underlying writable Bs instances, sorted by priority.
   */
  get writables(): Array<BsMultiBs> {
    /* v8 ignore next 2 -- @preserve */
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
