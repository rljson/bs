// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import {
  readBlocks,
  streamBlocks,
  verifyBlob,
  writeBlocks,
  ContentId,
} from './blob-blocks.ts';

import type {
  BlobBlock,
  BlobProperties,
  Bs,
  DownloadBlobOptions,
  ListBlobsOptions,
  ListBlobsResult,
} from './bs.js';

interface StoredBlob {
  blocks: BlobBlock[];
  properties: BlobProperties;
}

/**
 * In-memory implementation of content-addressable blob storage.
 * All blocks and blobs are stored in memory using Maps.
 * Useful for testing and development.
 */
export class BsMem implements Bs {
  private readonly blobs = new Map<string, StoredBlob>();
  private readonly blocks = new Map<string, Buffer>();

  /**
   * Reads one stored block.
   * @param blockId - The block.
   * @returns Its bytes.
   */
  private readonly _readBlock = async (blockId: string): Promise<Buffer> => {
    const bytes = this.blocks.get(blockId);
    if (!bytes) {
      throw new Error(`Block not found: ${blockId}`);
    }
    return bytes;
  };

  /**
   * The stored blob, or an error naming it.
   * @param blobId - The blob.
   */
  private _stored(blobId: string): StoredBlob {
    const stored = this.blobs.get(blobId);
    if (!stored) {
      throw new Error(`Blob not found: ${blobId}`);
    }
    return stored;
  }

  /**
   * Stores a blob's block list unless the blob is stored already.
   * @param blobId - The blob.
   * @param size - Its size.
   * @param blocks - Its blocks, all stored.
   * @returns The blob's properties.
   */
  private _storeBlob(
    blobId: string,
    size: number,
    blocks: BlobBlock[],
  ): BlobProperties {
    const existing = this.blobs.get(blobId);
    if (existing) {
      return existing.properties;
    }
    const properties: BlobProperties = { blobId, size, createdAt: new Date() };
    this.blobs.set(blobId, { blocks, properties });
    return properties;
  }

  async setBlob(
    content: Buffer | string | ReadableStream,
  ): Promise<BlobProperties> {
    const { blobId, size, blocks } = await writeBlocks(
      content,
      async ({ blockId }, bytes) => {
        // A copy: the bytes may be a view into a much larger buffer.
        if (!this.blocks.has(blockId)) {
          this.blocks.set(blockId, Buffer.from(bytes));
        }
      },
    );
    return this._storeBlob(blobId, size, blocks);
  }

  async getBlob(
    blobId: string,
    options?: DownloadBlobOptions,
  ): Promise<{ content: Buffer; properties: BlobProperties }> {
    const { blocks, properties } = this._stored(blobId);
    const content = await readBlocks(blocks, this._readBlock, options?.range);
    return { content, properties };
  }

  async getBlobStream(blobId: string): Promise<ReadableStream> {
    const { blocks } = this._stored(blobId);
    return streamBlocks(blobId, blocks, this._readBlock);
  }

  async getBlobBlocks(blobId: string): Promise<BlobBlock[]> {
    return this._stored(blobId).blocks;
  }

  async getBlock(blockId: string): Promise<Buffer> {
    return this._readBlock(blockId);
  }

  async blockExists(blockId: string): Promise<boolean> {
    return this.blocks.has(blockId);
  }

  async setBlock(content: Buffer): Promise<BlobBlock> {
    const blockId = ContentId.of(content);
    if (!this.blocks.has(blockId)) {
      this.blocks.set(blockId, Buffer.from(content));
    }
    return { blockId, size: content.length };
  }

  async setBlobBlocks(
    blobId: string,
    blocks: BlobBlock[],
  ): Promise<BlobProperties> {
    const existing = this.blobs.get(blobId);
    if (existing) {
      return existing.properties;
    }
    const size = await verifyBlob(blobId, blocks, this._readBlock);
    return this._storeBlob(blobId, size, blocks);
  }

  /**
   * Deletes a blob's block list. Its blocks stay: other blobs may contain
   * them.
   * @param blobId - The blob.
   */
  async deleteBlob(blobId: string): Promise<void> {
    const deleted = this.blobs.delete(blobId);
    if (!deleted) {
      throw new Error(`Blob not found: ${blobId}`);
    }
  }

  async blobExists(blobId: string): Promise<boolean> {
    return this.blobs.has(blobId);
  }

  async getBlobProperties(blobId: string): Promise<BlobProperties> {
    const stored = this.blobs.get(blobId);
    if (!stored) {
      throw new Error(`Blob not found: ${blobId}`);
    }
    return stored.properties;
  }

  async listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult> {
    let blobs = Array.from(this.blobs.values()).map(
      (stored) => stored.properties,
    );

    // Filter by prefix if provided
    if (options?.prefix) {
      blobs = blobs.filter((blob) => blob.blobId.startsWith(options.prefix!));
    }

    // Sort by blobId for consistent ordering
    blobs.sort((a, b) => a.blobId.localeCompare(b.blobId));

    // Handle pagination
    const maxResults = options?.maxResults ?? blobs.length;
    let startIndex = 0;

    if (options?.continuationToken) {
      // Continuation token is the last blobId from previous page
      // Find the next item after the token
      const tokenIndex = blobs.findIndex(
        (blob) => blob.blobId === options.continuationToken,
      );
      /* v8 ignore next -- @preserve */
      startIndex = tokenIndex === -1 ? 0 : tokenIndex + 1;
    }

    const endIndex = Math.min(startIndex + maxResults, blobs.length);
    const pageBlobs = blobs.slice(startIndex, endIndex);

    // Set continuation token if there are more results
    const continuationToken =
      endIndex < blobs.length
        ? pageBlobs[pageBlobs.length - 1]?.blobId
        : undefined;

    return {
      blobs: pageBlobs,
      continuationToken,
    };
  }

  async generateSignedUrl(
    blobId: string,
    expiresIn: number,
    permissions?: 'read' | 'delete',
  ): Promise<string> {
    // Check if blob exists
    if (!this.blobs.has(blobId)) {
      throw new Error(`Blob not found: ${blobId}`);
    }

    // For in-memory implementation, return a mock URL
    // In a real implementation, this would generate a proper signed URL
    const expires = Date.now() + expiresIn * 1000;
    const perm = permissions ?? 'read';
    return `mem://${blobId}?expires=${expires}&permissions=${perm}`;
  }

  /**
   * Clear all blobs and blocks from storage (useful for testing)
   */
  clear(): void {
    this.blobs.clear();
    this.blocks.clear();
  }

  /**
   * Get the number of blocks in storage
   */
  get blockCount(): number {
    return this.blocks.size;
  }

  /**
   * Get the number of blobs in storage
   */
  get size(): number {
    return this.blobs.size;
  }
}
