// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { readBlocks, streamBlocks } from './blob-blocks.ts';
import { BsMem } from './bs-mem.js';
import { BsPeer } from './bs-peer.js';
import { PeerSocketMock } from './peer-socket-mock.js';

import type {
  BlobBlock,
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
 * the hub deliberately places last, keeps exactly the behaviour it had.
 *
 * **It decides who is asked FIRST, never who is believed.** A source past the
 * bound is SET ASIDE, not abandoned: if no other source can answer, the
 * cascade comes back to it and waits out the source's own request timeout
 * (30 s in `BsPeer`). The first version of this did abandon it, and that cost
 * a working read within a day — `@rljson/server` CI, one test in 545: client B
 * asked for a blob only client A held, so the read went over a socket, through
 * the hub and back, which on a loaded runner takes longer than two seconds.
 * The cascade gave up with the data sitting there, reachable. *Slow is not
 * silent.*
 */
export const BLOB_SOURCE_TIMEOUT_MS = 2_000;

// ...........................................................................
/**
 * How long a source that lost its turn is asked after all others.
 *
 * A blob is read block by block, and every block is a question of its own. A
 * source that never answers would otherwise cost every one of them the bound
 * of {@link BLOB_SOURCE_TIMEOUT_MS} — two minutes for a 60-block file. Moved
 * to the end, it is still asked whenever nobody else can answer, so a slow
 * source is never given up on; it only stops being asked first. Afterwards it
 * gets its turn again, in case it recovered.
 */
export const SLOW_SOURCE_MEMORY_MS = 30_000;

// ...........................................................................
/**
 * A source that lost its turn, not a source that failed.
 *
 * Thrown by the bound so one `catch` can tell the two apart. It carries the
 * source's still-pending answer, which is the whole point: the cascade sets
 * the source aside, asks everybody else, and comes back to this promise if
 * nobody else could help.
 */
class SetAside extends Error {
  constructor(
    readonly pending: Promise<unknown>,
    readonly sourceId?: string,
  ) {
    super(
      `BsMulti: source did not answer within ${BLOB_SOURCE_TIMEOUT_MS}ms — ` +
        `asking the others first`,
    );
    this.name = 'SetAside';
  }
}

/**
 * Multi-tier Bs implementation that combines multiple underlying Bs instances
 * with different capabilities (read, write) and priorities.
 *
 * Pattern: Local cache + remote server fallback
 * - Lower priority number = checked first
 * - Reads block by block: each block from the highest priority readable that
 *   holds it, so blocks a writable already holds are never fetched again
 * - Every block read from elsewhere is kept in the writables, and a blob read
 *   whole is stored there once all its blocks are
 * - Writes to all writable instances in parallel
 */
export class BsMulti implements Bs {
  /** Source → until when it is asked after all others. */
  private readonly _slowUntil = new Map<Bs, number>();

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
   * The readables in the order they are asked: by priority, except that the
   * sources that recently lost their turn come last.
   * @returns The readables.
   */
  private _askOrder(): Array<BsMultiBs> {
    const now = Date.now();
    const slow = (store: BsMultiBs) =>
      (this._slowUntil.get(store.bs) ?? 0) > now;
    const readables = this.readables;
    return [
      ...readables.filter((store) => !slow(store)),
      ...readables.filter(slow),
    ];
  }

  /**
   * Whether any source after `index` could still answer.
   * @param order - The sources, in the order they are asked.
   * @param index - Position of the source being asked.
   * @returns True when a later, non-closed readable exists.
   */
  private _hasFallback(order: Array<BsMultiBs>, index: number): boolean {
    return order.slice(index + 1).some((later) => !this._isClosed(later.bs));
  }

  /**
   * Bounds one source's answer so the cascade can move on to the next.
   *
   * Only applied when a fallback exists — see {@link BLOB_SOURCE_TIMEOUT_MS}.
   * Past the bound this rejects with a {@link SetAside}, which the caller
   * recognises: the source is NOT a failure and NOT finished, it has simply
   * lost its turn. Its pending answer rides along on the marker so the caller
   * can come back to it when nobody else could help.
   * The source is also asked after all others for
   * {@link SLOW_SOURCE_MEMORY_MS}.
   * @param work - The source's pending answer.
   * @param order - The sources, in the order they are asked.
   * @param index - Position of the source in `order`.
   * @returns The answer, or a `SetAside` rejection once the bound passes.
   */
  private _bounded<T>(
    work: Promise<T>,
    order: Array<BsMultiBs>,
    index: number,
  ): Promise<T> {
    if (!this._hasFallback(order, index)) return work;
    const { bs, id } = order[index];
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this._slowUntil.set(bs, Date.now() + SLOW_SOURCE_MEMORY_MS);
          reject(new SetAside(work, id));
        }, BLOB_SOURCE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Throws away an answer nobody is waiting for any more. A rejection is
   * absorbed: it belongs to a question already answered elsewhere, and an
   * unhandled one would crash the process.
   * @param pending - The answer to discard.
   */
  private static _discard(pending: Promise<unknown>): void {
    void pending.catch(() => undefined);
  }

  /**
   * The message of something that was thrown, whatever it turned out to be.
   *
   * **A rejection is not always an `Error`.** socket.io serialises one across
   * the wire as `{}`, and `BsPeer.isReady` rejects with no argument at all.
   * Reading `.message` off those threw a `TypeError` — "Cannot read properties
   * of undefined" — from inside the code whose whole job was to explain a
   * failure, so the cascade reported a crash in itself instead of the blob it
   * could not find.
   * @param error - Whatever a source rejected with.
   * @returns Its message, or an empty string when it has none.
   */
  private static _messageOf(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    const message = (error as { message?: unknown } | undefined)?.message;
    return typeof message === 'string' ? message : '';
  }

  /**
   * Whatever was thrown, as something a caller can catch and read.
   * @param error - Whatever a source rejected with.
   * @returns The error itself, or an `Error` describing it.
   */
  private static _asError(error: unknown): Error {
    if (error instanceof Error) return error;
    const message = BsMulti._messageOf(error);
    if (message !== '') return new Error(message);
    // `JSON.stringify(undefined)` is `undefined`, not `'undefined'`.
    const described = JSON.stringify(error) ?? 'nothing';
    return new Error(`BsMulti: a source failed with ${described}`);
  }

  /**
   * Classifies an exhausted cascade and throws the right thing.
   *
   * **A real failure outranks an absence, wherever in the list it sits.** Only
   * when EVERY source said "not found" is the blob actually absent; if one of
   * them broke, reporting an absence would be a lie with consequences — a sync
   * agent that believes a blob is gone can decide to delete what points at it.
   *
   * The code this replaces threw `errors[0]`, which was the first error rather
   * than the first real one, and its own comment said otherwise. That was
   * harmless while the cascade only ever recorded errors in source order; it
   * stopped being harmless once a source could be set aside and re-asked at
   * the END, which puts its failure last.
   * @param errors - Everything the sources rejected with.
   * @param what - `Blob` or `Block`.
   * @param id - The blob or block that could not be read.
   */
  private static _throwExhausted(
    errors: unknown[],
    what: 'Blob' | 'Block',
    id: string,
  ): never {
    // `findIndex`, not `find`: `BsPeer.isReady` rejects with NO ARGUMENT, so a
    // real failure can itself be `undefined` — and `find` cannot tell that
    // apart from having found nothing. It would report an absence for a source
    // that broke, which is the one lie this method exists to avoid.
    const first = errors.findIndex(
      (error) => !BsMulti._messageOf(error).includes(`${what} not found`),
    );
    if (first === -1) {
      throw new Error(`${what} not found: ${id}`);
    }
    throw BsMulti._asError(errors[first]);
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
   * Asks the readables in priority order until one answers.
   *
   * Skips sources it can see are closed, and sets aside a source that does not
   * answer within {@link BLOB_SOURCE_TIMEOUT_MS} while a later one could —
   * coming back to it when nobody else could help.
   * @param what - `Blob` or `Block`, for the errors.
   * @param id - The blob or block asked for, for the errors.
   * @param ask - The question to one source.
   * @returns The first answer and the id of the source that gave it.
   */
  private async _firstAnswer<T>(
    what: 'Blob' | 'Block',
    id: string,
    ask: (bs: Bs) => Promise<T>,
  ): Promise<{ value: T; sourceId: string }> {
    if (this.readables.length === 0) {
      throw new Error('No readable Bs available');
    }

    const errors: unknown[] = [];
    const setAside: SetAside[] = [];
    let allClosed = true;

    // Try readables in priority order
    const order = this._askOrder();
    for (let index = 0; index < order.length; index++) {
      const readable = order[index];
      if (this._isClosed(readable.bs)) {
        continue; // Skip known-closed peers instead of hanging on them
      }
      allClosed = false;
      try {
        const value = await this._bounded(ask(readable.bs), order, index);
        for (const aside of setAside) BsMulti._discard(aside.pending);
        return { value, sourceId: readable.id ?? '' };
      } catch (e) {
        if (e instanceof SetAside) setAside.push(e);
        else errors.push(e);
        continue;
      }
    }

    // Nobody else could answer, so come back to the sources that only lost
    // their turn. Each still carries its own request timeout.
    for (let i = 0; i < setAside.length; i++) {
      try {
        const value = (await setAside[i].pending) as T;
        for (const rest of setAside.slice(i + 1)) {
          BsMulti._discard(rest.pending);
        }
        return { value, sourceId: setAside[i].sourceId ?? '' };
      } catch (e) {
        errors.push(e);
      }
    }

    if (allClosed) {
      // No member was ever queried — this is a topology failure, not a
      // verified absence, so it must not look like "not found".
      throw new Error('All readable Bs instances are closed');
    }
    BsMulti._throwExhausted(errors, what, id);
  }

  // ...........................................................................
  /**
   * Asks the readables in priority order whether one holds something.
   * @param ask - The question to one source.
   * @returns True as soon as one source says so.
   */
  private async _anyHolds(ask: (bs: Bs) => Promise<boolean>): Promise<boolean> {
    if (this.readables.length === 0) {
      throw new Error('No readable Bs available');
    }

    // Check readables in priority order
    let allClosed = true;
    const setAside: SetAside[] = [];
    const order = this._askOrder();
    for (let index = 0; index < order.length; index++) {
      const readable = order[index];
      if (this._isClosed(readable.bs)) {
        continue; // Skip known-closed peers instead of hanging on them
      }
      allClosed = false;
      try {
        if (await this._bounded(ask(readable.bs), order, index)) {
          for (const aside of setAside) BsMulti._discard(aside.pending);
          return true;
        }
      } catch (e) {
        if (e instanceof SetAside) setAside.push(e);
        continue;
      }
    }

    // `false` here would be a verified absence, and a source that only lost
    // its turn has verified nothing. Ask it before answering.
    for (let i = 0; i < setAside.length; i++) {
      try {
        if ((await setAside[i].pending) === true) {
          for (const rest of setAside.slice(i + 1)) {
            BsMulti._discard(rest.pending);
          }
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
   * Stores a blob read whole in every writable that lacks it. Its blocks are
   * there already: {@link getBlock} keeps every block it reads elsewhere.
   * A failure only means the cache stays incomplete, never a failed read.
   * @param blobId - The blob.
   * @param blocks - Its blocks, in order.
   */
  private async _keep(blobId: string, blocks: BlobBlock[]): Promise<void> {
    await Promise.all(
      this.writables.map(async ({ bs }) => {
        try {
          if (!(await bs.blobExists(blobId))) {
            await bs.setBlobBlocks(blobId, blocks);
          }
        } catch {
          // A cache that could not be completed is a cache, not a failure.
        }
      }),
    );
  }

  // ...........................................................................
  /**
   * Retrieves a blob, block by block, each from the highest priority readable
   * that holds it. A blob read whole is kept in the writables.
   * @param blobId - The blob identifier
   * @param options - Download options
   * @returns Promise resolving to blob content and properties
   */
  async getBlob(
    blobId: string,
    options?: DownloadBlobOptions,
  ): Promise<{ content: Buffer; properties: BlobProperties }> {
    const properties = await this.getBlobProperties(blobId);
    const blocks = await this.getBlobBlocks(blobId);
    const content = await readBlocks(
      blocks,
      (blockId) => this.getBlock(blockId),
      options?.range,
    );
    if (!options?.range) await this._keep(blobId, blocks);
    return { content, properties };
  }

  // ...........................................................................
  /**
   * Retrieves a blob as a ReadableStream, block by block, each from the
   * highest priority readable that holds it. Once the stream was read to its
   * end, the blob is kept in the writables.
   * @param blobId - The blob identifier
   * @returns Promise resolving to a ReadableStream
   */
  async getBlobStream(blobId: string): Promise<ReadableStream<Uint8Array>> {
    const blocks = await this.getBlobBlocks(blobId);
    return streamBlocks(
      blobId,
      blocks,
      (blockId) => this.getBlock(blockId),
      () => this._keep(blobId, blocks),
    );
  }

  // ...........................................................................
  /**
   * Gets the blocks of a blob from the highest priority readable that has it.
   * @param blobId - The blob identifier
   * @returns Promise resolving to the blocks, in order
   */
  async getBlobBlocks(blobId: string): Promise<BlobBlock[]> {
    return (
      await this._firstAnswer('Blob', blobId, (bs) => bs.getBlobBlocks(blobId))
    ).value;
  }

  // ...........................................................................
  /**
   * Gets one block from the highest priority readable that holds it, and
   * keeps it in every writable except the one it came from.
   * @param blockId - The block identifier
   * @returns Promise resolving to the block's bytes
   */
  async getBlock(blockId: string): Promise<Buffer> {
    const { value, sourceId } = await this._firstAnswer(
      'Block',
      blockId,
      (bs) => bs.getBlock(blockId),
    );
    await Promise.all(
      this.writables
        .filter((writable) => writable.id !== sourceId)
        .map(({ bs }) => bs.setBlock(value).catch(() => undefined)),
    );
    return value;
  }

  // ...........................................................................
  /**
   * Checks if a block exists in any readable Bs instance.
   * @param blockId - The block identifier
   * @returns Promise resolving to true if the block exists in any readable
   */
  async blockExists(blockId: string): Promise<boolean> {
    return this._anyHolds((bs) => bs.blockExists(blockId));
  }

  // ...........................................................................
  /**
   * Stores one block in all writable Bs instances in parallel.
   * @param content - The block's bytes
   * @returns Promise resolving to the stored block
   */
  async setBlock(content: Buffer): Promise<BlobBlock> {
    if (this.writables.length === 0) {
      throw new Error('No writable Bs available');
    }
    const results = await Promise.all(
      this.writables.map(({ bs }) => bs.setBlock(content)),
    );
    return results[0];
  }

  // ...........................................................................
  /**
   * Stores a blob made of held blocks in all writable Bs instances in
   * parallel.
   * @param blobId - The blob identifier
   * @param blocks - Its blocks, in order
   * @returns Promise resolving to blob properties
   */
  async setBlobBlocks(
    blobId: string,
    blocks: BlobBlock[],
  ): Promise<BlobProperties> {
    if (this.writables.length === 0) {
      throw new Error('No writable Bs available');
    }
    const results = await Promise.all(
      this.writables.map(({ bs }) => bs.setBlobBlocks(blobId, blocks)),
    );
    return results[0];
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
    return this._anyHolds((bs) => bs.blobExists(blobId));
  }

  // ...........................................................................
  /**
   * Gets blob properties from the highest priority readable Bs instance.
   * @param blobId - The blob identifier
   * @returns Promise resolving to blob properties
   */
  async getBlobProperties(blobId: string): Promise<BlobProperties> {
    return (
      await this._firstAnswer('Blob', blobId, (bs) =>
        bs.getBlobProperties(blobId),
      )
    ).value;
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
