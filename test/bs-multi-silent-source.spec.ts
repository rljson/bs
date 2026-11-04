// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// A SOURCE THAT IS OPEN AND NEVER ANSWERS.
//
// Every read in `BsMulti` walks the readables in priority order and only skips
// a source it can SEE is gone (`_isClosed`). A source that is still open and
// simply never answers therefore blocked the whole cascade for its full
// request timeout — a half-open TCP socket, a firewall that drops without
// resetting, a peer under load.
//
// A blob read is on the RESTORE path, so the cost landed on a user's files.
// Traced in `@rljson/fs-agent`: a node fetched a peer's tree in 4 s, started
// the restore, and the restore timed out at 15 s because the blob fetch was
// waiting on a cut peer. The re-created file arrived only when the test window
// was widened to 120 s.
//
// The bound applies only while a FALLBACK exists — see
// `BLOB_SOURCE_TIMEOUT_MS`. The last readable is never bounded, because there
// is nobody else to ask.
// .............................................................................

import { describe, expect, it, vi } from 'vitest';

import {
  BLOB_SOURCE_TIMEOUT_MS,
  Bs,
  BsMem,
  BsMulti,
  BsMultiBs,
  SLOW_SOURCE_MEMORY_MS,
} from '../src';

/** A store that is OPEN and never answers a read. */
const silentStore = (inner: Bs): Bs =>
  new Proxy(inner, {
    get(target, prop, receiver) {
      if (
        prop === 'getBlob' ||
        prop === 'getBlobStream' ||
        prop === 'getBlobBlocks' ||
        prop === 'getBlock' ||
        prop === 'blockExists' ||
        prop === 'blobExists' ||
        prop === 'getBlobProperties'
      ) {
        return () => new Promise(() => {}); // never settles
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Bs;

/** Deadline comfortably above the bound and far below any 30 s peer timeout. */
const DEADLINE_MS = BLOB_SOURCE_TIMEOUT_MS + 3_000;

const raced = async <T>(work: Promise<T>): Promise<T | 'late'> => {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), DEADLINE_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

describe('BsMulti — a source that never answers', () => {
  const build = async () => {
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');

    const silentInner = new BsMem();
    const silent = silentStore(silentInner);

    const stores: Array<BsMultiBs> = [
      // Silent FIRST, so the cascade hits it before the store that can answer.
      { bs: silent, priority: 0, read: true, write: false },
      { bs: holder, priority: 1, read: true, write: false },
    ];
    const bsMulti = new BsMulti(stores);
    await bsMulti.init();
    return { bsMulti, blobId };
  };

  // ...........................................................................
  it('getBlob answers from the next source', async () => {
    const { bsMulti, blobId } = await build();
    const result = await raced(bsMulti.getBlob(blobId));
    expect(result, 'getBlob waited out a silent source').not.toBe('late');
    expect((result as { content: Buffer }).content.toString('utf8')).toBe(
      'the bytes',
    );
  }, 20_000);

  // ...........................................................................
  it('getBlobStream answers from the next source — the restore path', async () => {
    const { bsMulti, blobId } = await build();
    const result = await raced(bsMulti.getBlobStream(blobId));
    expect(result, 'getBlobStream waited out a silent source').not.toBe('late');
    // And it is a usable stream, not merely something that resolved.
    const reader = (result as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value as Uint8Array).toString('utf8')).toContain(
      'the bytes',
    );
    await reader.cancel();
  }, 20_000);

  // ...........................................................................
  it('blobExists answers from the next source', async () => {
    const { bsMulti, blobId } = await build();
    const result = await raced(bsMulti.blobExists(blobId));
    expect(result, 'blobExists waited out a silent source').not.toBe('late');
    expect(result).toBe(true);
  }, 20_000);

  // ...........................................................................
  it('getBlobProperties answers from the next source', async () => {
    const { bsMulti, blobId } = await build();
    const result = await raced(bsMulti.getBlobProperties(blobId));
    expect(result, 'getBlobProperties waited out a silent source').not.toBe(
      'late',
    );
  }, 20_000);

  // ...........................................................................
  it('reads each block from the next source when one knows the blob but not its blocks', async () => {
    // Blocks are asked for one by one, each through the whole cascade. A
    // source that answered the block list and then goes silent costs every
    // block the bound, not the read its whole request timeout.
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');
    const listInner = new BsMem();
    await listInner.setBlob('the bytes');
    const listOnly = new Proxy(listInner, {
      get(target, prop, receiver) {
        if (prop === 'getBlock') return () => new Promise(() => {});
        return Reflect.get(target, prop, receiver);
      },
    }) as Bs;

    const bsMulti = new BsMulti([
      { bs: listOnly, priority: 0, read: true, write: false },
      { bs: holder, priority: 1, read: true, write: false },
    ]);
    await bsMulti.init();

    const result = await raced(bsMulti.getBlob(blobId));
    expect(result, 'a block read waited out a silent source').not.toBe('late');
    expect((result as { content: Buffer }).content.toString('utf8')).toBe(
      'the bytes',
    );
  }, 20_000);

  // ...........................................................................
  it('costs one bound for a blob of many blocks, not one per block', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4) {
      bytes.writeUInt32LE(Math.imul(i, 2654435761) >>> 0, i);
    }
    const holder = new BsMem();
    const { blobId } = await holder.setBlob(bytes);
    expect((await holder.getBlobBlocks(blobId)).length).toBeGreaterThan(3);

    const bsMulti = new BsMulti([
      { bs: silentStore(new BsMem()), priority: 0, read: true, write: false },
      { bs: holder, priority: 1, read: true, write: false },
    ]);
    await bsMulti.init();

    const result = await raced(bsMulti.getBlob(blobId));
    expect(result, 'every block waited out the silent source').not.toBe('late');
    expect((result as { content: Buffer }).content.equals(bytes)).toBe(true);
  }, 20_000);

  // ...........................................................................
  it('asks a slow source first again once the memory has passed', async () => {
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');
    let asked = 0;
    const slowInner = new BsMem();
    const slow = new Proxy(slowInner, {
      get(target, prop, receiver) {
        if (prop === 'blobExists') {
          return () => {
            asked++;
            return new Promise(() => {});
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Bs;

    const bsMulti = new BsMulti([
      { bs: slow, priority: 0, read: true, write: false },
      { bs: holder, priority: 1, read: true, write: false },
    ]);
    await bsMulti.init();

    // Set aside once: asked, then the holder answers.
    expect(await bsMulti.blobExists(blobId)).toBe(true);
    expect(asked).toBe(1);

    // Within the memory the holder is asked first and answers.
    expect(await bsMulti.blobExists(blobId)).toBe(true);
    expect(asked).toBe(1);

    // Afterwards the slow source gets its turn first again.
    const now = Date.now();
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(now + SLOW_SOURCE_MEMORY_MS + 1);
    try {
      expect(await bsMulti.blobExists(blobId)).toBe(true);
      expect(asked).toBe(2);
    } finally {
      clock.mockRestore();
    }
  }, 20_000);

  // ...........................................................................
  it('discards a late answer, without complaint', async () => {
    // A source that is abandoned and then answers ANYWAY: the bound
    // rejected, the cascade moved on, and the slow answer still turns up
    // afterwards. Nobody waits for it any more, so it is simply let go.
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');

    const lateInner = new BsMem();
    await lateInner.setBlob('the bytes');
    const late = new Proxy(lateInner, {
      get(target, prop, receiver) {
        if (prop === 'getBlock') {
          return async (id: string) => {
            await new Promise((r) =>
              setTimeout(r, BLOB_SOURCE_TIMEOUT_MS + 300),
            );
            return (target as Bs).getBlock(id);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Bs;

    const bsMulti = new BsMulti([
      { bs: late, priority: 0, read: true, write: false },
      { bs: holder, priority: 1, read: true, write: false },
    ]);
    await bsMulti.init();

    const result = await bsMulti.getBlob(blobId);
    expect(result.content.toString('utf8')).toBe('the bytes');
    // The late answer arrives here and must be dropped silently.
    await new Promise((r) => setTimeout(r, 800));
  }, 20_000);

  // ...........................................................................
  it('swallows a late FAILURE from an abandoned source', async () => {
    // The mirror of the two above: the abandoned source eventually rejects
    // rather than answering. Nobody is waiting on that promise any more, so
    // the rejection has to be absorbed — left unhandled it would surface as an
    // unhandled rejection warning long after the read it belonged to
    // succeeded, which is the kind of noise that gets investigated as a bug.
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');

    const lateInner = new BsMem();
    await lateInner.setBlob('the bytes');
    const late = new Proxy(lateInner, {
      get(target, prop, receiver) {
        if (prop === 'getBlock') {
          return async () => {
            await new Promise((r) =>
              setTimeout(r, BLOB_SOURCE_TIMEOUT_MS + 300),
            );
            throw new Error('the peer gave up, late');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Bs;

    const bsMulti = new BsMulti([
      { bs: late, priority: 0, read: true, write: false },
      { bs: holder, priority: 1, read: true, write: false },
    ]);
    await bsMulti.init();

    const result = await bsMulti.getBlob(blobId);
    expect(result.content.toString('utf8')).toBe('the bytes');
    // The late rejection lands in this window and must be absorbed.
    await new Promise((r) => setTimeout(r, 800));
  }, 20_000);

  // ...........................................................................
  it('does NOT bound the last source, because nobody else can be asked', async () => {
    // The whole point of the rule: a cloud store sits last by design, and a
    // slow answer from it is the only answer there is. Here the only store
    // answers after the bound would have fired, and the read still succeeds.
    const slow = new BsMem();
    const { blobId } = await slow.setBlob('from the only source');
    const realGet = slow.getBlock.bind(slow);
    slow.getBlock = (async (id: string) => {
      await new Promise((r) => setTimeout(r, BLOB_SOURCE_TIMEOUT_MS + 500));
      return realGet(id);
    }) as typeof slow.getBlock;

    const bsMulti = new BsMulti([
      { bs: slow, priority: 0, read: true, write: false },
    ]);
    await bsMulti.init();

    const result = await raced(bsMulti.getBlob(blobId));
    expect(result, 'the only source was bounded and abandoned').not.toBe(
      'late',
    );
    expect((result as { content: Buffer }).content.toString('utf8')).toBe(
      'from the only source',
    );
  }, 20_000);
});
