// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/**
 * Content-addressable blob storage interface.
 * Blobs are identified by SHA256 hash of their content.
 * Uses a flat storage pool - all blobs are stored globally by their content hash.
 * Metadata and organizational grouping is managed externally.
 *
 * Every blob is stored as a list of blocks, cut at boundaries the content
 * decides (see `blob-blocks.ts`). A block is identified by the hash of its own
 * bytes and stored once, however many blobs contain it. Between stores only
 * blocks travel: a reader asks for a blob's block list and fetches the blocks
 * it lacks, so two versions of a file that share most of their bytes share
 * most of their blocks.
 */

/**
 * Properties of a blob (minimal, as metadata is external)
 */
export interface BlobProperties {
  /** SHA256 hash of the blob content (unique identifier) */
  blobId: string;
  /** Size in bytes */
  size: number;
  /** When the blob was first stored */
  createdAt: Date;
}

/**
 * Options for downloading a blob
 */
export interface DownloadBlobOptions {
  /** Download only a byte range (e.g., for resumable downloads) */
  range?: {
    start: number;
    end?: number;
  };
}

/**
 * One block of a blob.
 */
export interface BlobBlock {
  /** SHA256 hash of the block's bytes (unique identifier) */
  blockId: string;
  /** Size in bytes */
  size: number;
}

/**
 * Options for listing blobs
 */
export interface ListBlobsOptions {
  /** Filter by ID prefix */
  prefix?: string;
  /** Maximum number of results */
  maxResults?: number;
  /** Continuation token for pagination */
  continuationToken?: string;
}

/**
 * Result of listing blobs
 */
export interface ListBlobsResult {
  /** Array of blob properties */
  blobs: BlobProperties[];
  /** Token for fetching next page */
  continuationToken?: string;
}

/**
 * Content-Addressable Blob Storage Interface
 * Flat storage pool - no containers/buckets needed
 */
export interface Bs {
  /**
   * Store a blob. The blob ID (SHA256 hash) is calculated from content.
   * If a blob with the same content already exists, it returns existing blob properties.
   * @param content - Blob content (Buffer, string, or stream)
   * @returns Properties of the stored blob (including calculated blobId)
   */
  setBlob(content: Buffer | string | ReadableStream): Promise<BlobProperties>;

  /**
   * Get a blob from storage by its ID
   * @param blobId - SHA256 hash of the blob
   * @param options - Download options
   * @returns Blob content and properties
   */
  getBlob(
    blobId: string,
    options?: DownloadBlobOptions,
  ): Promise<{ content: Buffer; properties: BlobProperties }>;

  /**
   * Get a readable stream for a blob
   * @param blobId - SHA256 hash of the blob
   * @returns Readable stream
   */
  getBlobStream(blobId: string): Promise<ReadableStream>;

  /**
   * Delete a blob by its ID
   * Note: In a production system, consider reference counting before deletion
   * @param blobId - SHA256 hash of the blob
   */
  deleteBlob(blobId: string): Promise<void>;

  /**
   * Check if a blob exists
   * @param blobId - SHA256 hash of the blob
   * @returns True if exists
   */
  blobExists(blobId: string): Promise<boolean>;

  /**
   * Get blob properties without downloading content
   * @param blobId - SHA256 hash of the blob
   * @returns Blob properties
   */
  getBlobProperties(blobId: string): Promise<BlobProperties>;

  /**
   * List all blobs in the storage pool
   * @param options - List options
   * @returns List of blobs with optional continuation token
   */
  listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult>;

  /**
   * Get a signed URL for temporary access to a blob
   * @param blobId - SHA256 hash of the blob
   * @param expiresIn - Expiration time in seconds
   * @param permissions - Permissions ('read' or 'delete')
   * @returns Signed URL
   */
  generateSignedUrl(
    blobId: string,
    expiresIn: number,
    permissions?: 'read' | 'delete',
  ): Promise<string>;

  /**
   * Get the blocks a blob is made of, in order
   * @param blobId - SHA256 hash of the blob
   * @returns The blocks; their sizes add up to the blob's size
   */
  getBlobBlocks(blobId: string): Promise<BlobBlock[]>;

  /**
   * Get the bytes of one block
   * @param blockId - SHA256 hash of the block
   * @returns The block's bytes
   */
  getBlock(blockId: string): Promise<Buffer>;

  /**
   * Check if a block exists
   * @param blockId - SHA256 hash of the block
   * @returns True if exists
   */
  blockExists(blockId: string): Promise<boolean>;

  /**
   * Store one block. The block ID is calculated from its bytes.
   * @param content - The block's bytes, at most `BLOCK_MAX_BYTES`
   * @returns The stored block
   */
  setBlock(content: Buffer): Promise<BlobBlock>;

  /**
   * Store a blob made of blocks this storage already holds.
   * Fails when a block is missing or when the blocks together do not hash to
   * `blobId`, so a blob is only ever stored under the hash of its content.
   * @param blobId - SHA256 hash of the whole blob
   * @param blocks - The blob's blocks, in order
   * @returns Properties of the stored blob
   */
  setBlobBlocks(blobId: string, blocks: BlobBlock[]): Promise<BlobProperties>;
}
