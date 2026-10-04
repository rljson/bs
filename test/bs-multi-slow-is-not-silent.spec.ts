// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................
// SLOW IS NOT SILENT.
//
// `BLOB_SOURCE_TIMEOUT_MS` was added so a source that is open and never
// answers cannot hold the cascade (see `bs-multi-silent-source.spec.ts`). It
// bought that with a assumption nobody checked: that a source which has not
// answered within the bound was never going to.
//
// It cost a working read the day it shipped. `@rljson/server`'s CI, one test
// in 545: client B asks for a blob that only client A holds, so the read goes
// out over a socket, through the hub, and back. On a loaded runner that took
// longer than the bound, the cascade abandoned it, no other source had the
// blob — and the read FAILED with the data sitting there, reachable. A blob is
// not a row: it can be 50 MB, and the product's own ceiling says so.
//
// The rule this file pins: **the bound decides who is asked FIRST, never who
// is believed.** A bounded source is set aside, not cancelled; if nobody else
// can answer, the cascade comes back to it and waits out its own timeout —
// 30 s in `BsPeer`, which is the source's own promise about itself.
//
// Second fault, and it is what the CI failure actually threw:
// `TypeError: Cannot read properties of undefined (reading 'includes')`. The
// exhausted path classifies the errors it collected by reading
// `err.message`, and a rejection is not always an `Error`. socket.io
// serialises an `Error` across the wire as `{}`, and `BsPeer.isReady` rejects
// with no argument at all. Reaching that line was rare before the bound; the
// bound made the cascade exhaust where it used to succeed, and the latent
// crash came with it.
// .............................................................................

import { describe, expect, it } from 'vitest';

import { BLOB_SOURCE_TIMEOUT_MS, Bs, BsMem, BsMulti, BsMultiBs } from '../src';

/** A store that answers correctly, but only after `delayMs`. */
const slowStore = (inner: Bs, delayMs: number): Bs =>
  new Proxy(inner, {
    get(target, prop, receiver) {
      const guarded =
        prop === 'getBlob' ||
        prop === 'getBlobStream' ||
        prop === 'blobExists' ||
        prop === 'getBlobProperties';
      if (!guarded) return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return (Reflect.get(target, prop, receiver) as (
          ...a: unknown[]
        ) => unknown).apply(target, args);
      };
    },
  }) as Bs;

/** A store that rejects with something that is NOT an Error. */
const throwsNonErrorStore = (inner: Bs, thrown: unknown): Bs =>
  new Proxy(inner, {
    get(target, prop, receiver) {
      if (
        prop === 'getBlob' ||
        prop === 'getBlobStream' ||
        prop === 'blobExists' ||
        prop === 'getBlobProperties'
      ) {
        return () => Promise.reject(thrown);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Bs;

/** A store that fails with a described error, not with "Blob not found". */
const failingStore = (inner: Bs): Bs =>
  new Proxy(inner, {
    get(target, prop, receiver) {
      if (
        prop === 'getBlob' ||
        prop === 'getBlobStream' ||
        prop === 'blobExists' ||
        prop === 'getBlobProperties'
      ) {
        return () => Promise.reject(new Error('this source fails on purpose'));
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Bs;

/** Slower than the bound, faster than any source's own request timeout. */
const SLOW_MS = BLOB_SOURCE_TIMEOUT_MS + 1_500;

describe('BsMulti — a source that is slow, not silent', () => {
  /**
   * The slow store is the ONLY holder, and it is not last — so it gets
   * bounded, and the cascade has to come back to it.
   */
  const build = async (delayMs = SLOW_MS) => {
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');

    const stores: Array<BsMultiBs> = [
      { bs: slowStore(holder, delayMs), priority: 0, read: true, write: false },
      // A fallback that exists, is open, and does NOT have the blob. Its
      // presence is what arms the bound on the source above it.
      { bs: new BsMem(), priority: 1, read: true, write: false },
    ];
    const bsMulti = new BsMulti(stores);
    await bsMulti.init();
    return { bsMulti, blobId };
  };

  // ...........................................................................
  it('getBlob still returns the blob only the slow source holds', async () => {
    const { bsMulti, blobId } = await build();
    const { content } = await bsMulti.getBlob(blobId);
    expect(content.toString('utf8')).toBe('the bytes');
  }, 30_000);

  // ...........................................................................
  it('getBlobStream still returns the stream only the slow source holds', async () => {
    const { bsMulti, blobId } = await build();
    const stream = await bsMulti.getBlobStream(blobId);
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value as Uint8Array).toString('utf8')).toContain(
      'the bytes',
    );
    await reader.cancel();
  }, 30_000);

  // ...........................................................................
  it('blobExists still finds what only the slow source holds', async () => {
    const { bsMulti, blobId } = await build();
    expect(await bsMulti.blobExists(blobId)).toBe(true);
  }, 30_000);

  // ...........................................................................
  it('getBlobProperties still answers from the slow source', async () => {
    const { bsMulti, blobId } = await build();
    const properties = await bsMulti.getBlobProperties(blobId);
    expect(properties.blobId).toBe(blobId);
  }, 30_000);

  // ...........................................................................
  it('a fallback that CAN answer is still preferred over waiting', async () => {
    // The guarantee from `bs-multi-silent-source.spec.ts` must survive: when
    // somebody else has the blob, the slow source is not waited for.
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');
    const slowHolder = new BsMem();
    await slowHolder.setBlob('the bytes');

    const bsMulti = new BsMulti([
      {
        bs: slowStore(slowHolder, 20_000),
        priority: 0,
        read: true,
        write: false,
      },
      { bs: holder, priority: 1, read: true, write: false },
    ]);
    await bsMulti.init();

    const started = Date.now();
    const { content } = await bsMulti.getBlob(blobId);
    expect(content.toString('utf8')).toBe('the bytes');
    expect(
      Date.now() - started,
      'waited for the slow source although a fallback had the blob',
    ).toBeLessThan(BLOB_SOURCE_TIMEOUT_MS + 2_000);
  }, 30_000);
});

// ...........................................................................
describe('BsMulti — a rejection that is not an Error', () => {
  // `{}` is what socket.io delivers when the far side rejects with an Error;
  // `undefined` is what `BsPeer.isReady` rejects with. Neither has a message,
  // and the exhausted path read `err.message` unguarded.
  // Each case names the message the cascade must END UP reporting, because
  // "it threw something" is what the TypeError did too.
  for (const [label, thrown, expected] of [
    ['a plain object, as socket.io delivers an Error', {}, 'failed with {}'],
    [
      'no argument at all, as BsPeer.isReady rejects',
      undefined,
      'failed with nothing',
    ],
    ['a string', 'something went wrong', 'something went wrong'],
    [
      'an object whose message is not a string',
      { message: 42 },
      'failed with {"message":42}',
    ],
    [
      'an object that carries a message but is not an Error',
      { message: 'the far side said no' },
      'the far side said no',
    ],
  ] as Array<[string, unknown, string]>) {
    it(`getBlob reports the failure when a source rejects with ${label}`, async () => {
      const bsMulti = new BsMulti([
        {
          bs: throwsNonErrorStore(new BsMem(), thrown),
          priority: 0,
          read: true,
          write: false,
        },
        { bs: new BsMem(), priority: 1, read: true, write: false },
      ]);
      await bsMulti.init();

      // A source BROKE, so the answer must say so. Reporting "Blob not found"
      // here would be a verified absence that nobody verified — and a sync
      // agent that believes a blob is gone can delete what points at it.
      await expect(bsMulti.getBlob('missing')).rejects.toThrow(expected);
    }, 30_000);
  }
});

// ...........................................................................
describe('BsMulti — more than one source set aside', () => {
  /**
   * Two slow sources and a fast one that does not have the blob. The cascade
   * sets BOTH slow sources aside, finds nothing, and then has to work through
   * them in priority order — which is the only path on which a set-aside
   * source can itself fail and the ones behind it still have to be asked.
   */
  const buildTwoSetAside = async (firstFails: boolean) => {
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');

    const first = firstFails
      ? slowStore(failingStore(new BsMem()), SLOW_MS)
      : slowStore(holder, SLOW_MS);
    const second = slowStore(holder, SLOW_MS);

    const bsMulti = new BsMulti([
      { bs: first, priority: 0, read: true, write: false },
      { bs: second, priority: 1, read: true, write: false },
      // Fast, open, and empty — it is what arms the bound on both of the above.
      { bs: new BsMem(), priority: 2, read: true, write: false },
    ]);
    await bsMulti.init();
    return { bsMulti, blobId };
  };

  // .........................................................................
  it('getBlob falls through a set-aside source that fails to the next one', async () => {
    const { bsMulti, blobId } = await buildTwoSetAside(true);
    const { content } = await bsMulti.getBlob(blobId);
    expect(content.toString('utf8')).toBe('the bytes');
  }, 30_000);

  // .........................................................................
  it('getBlob stops at the first set-aside source that answers', async () => {
    const { bsMulti, blobId } = await buildTwoSetAside(false);
    const { content } = await bsMulti.getBlob(blobId);
    expect(content.toString('utf8')).toBe('the bytes');
  }, 30_000);

  // .........................................................................
  it('getBlobStream falls through a failing set-aside source', async () => {
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');
    const bsMulti = new BsMulti([
      {
        bs: slowStore(failingStore(new BsMem()), SLOW_MS),
        priority: 0,
        read: true,
        write: false,
      },
      { bs: slowStore(holder, SLOW_MS), priority: 1, read: true, write: false },
      { bs: new BsMem(), priority: 2, read: true, write: false },
    ]);
    await bsMulti.init();

    const stream = await bsMulti.getBlobStream(blobId);
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value as Uint8Array).toString('utf8')).toContain(
      'the bytes',
    );
    await reader.cancel();
  }, 30_000);

  // .........................................................................
  it('blobExists walks past a set-aside source that fails', async () => {
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');
    const bsMulti = new BsMulti([
      {
        bs: slowStore(failingStore(new BsMem()), SLOW_MS),
        priority: 0,
        read: true,
        write: false,
      },
      { bs: slowStore(holder, SLOW_MS), priority: 1, read: true, write: false },
      { bs: new BsMem(), priority: 2, read: true, write: false },
    ]);
    await bsMulti.init();
    expect(await bsMulti.blobExists(blobId)).toBe(true);
  }, 30_000);

  // .........................................................................
  it('blobExists answers false when every set-aside source says no', async () => {
    // Set aside, asked again, and genuinely absent — `false` here is a
    // verified absence, which is the thing it is allowed to report.
    const bsMulti = new BsMulti([
      { bs: slowStore(new BsMem(), SLOW_MS), priority: 0, read: true, write: false },
      { bs: new BsMem(), priority: 1, read: true, write: false },
    ]);
    await bsMulti.init();
    expect(await bsMulti.blobExists('missing')).toBe(false);
  }, 30_000);

  // .........................................................................
  it('getBlobProperties falls through a failing set-aside source', async () => {
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');
    const bsMulti = new BsMulti([
      {
        bs: slowStore(failingStore(new BsMem()), SLOW_MS),
        priority: 0,
        read: true,
        write: false,
      },
      { bs: slowStore(holder, SLOW_MS), priority: 1, read: true, write: false },
      { bs: new BsMem(), priority: 2, read: true, write: false },
    ]);
    await bsMulti.init();
    expect((await bsMulti.getBlobProperties(blobId)).blobId).toBe(blobId);
  }, 30_000);

  // .........................................................................
  it('reports a real failure when every set-aside source fails', async () => {
    const bsMulti = new BsMulti([
      {
        bs: slowStore(failingStore(new BsMem()), SLOW_MS),
        priority: 0,
        read: true,
        write: false,
      },
      { bs: new BsMem(), priority: 1, read: true, write: false },
    ]);
    await bsMulti.init();
    await expect(bsMulti.getBlob('missing')).rejects.toThrow(/on purpose/);
  }, 30_000);

  // .........................................................................
  it('hot-swaps from a set-aside source that has no id yet', async () => {
    // `init()` is what assigns the ids, and nothing forces a caller to call
    // it — `bs-multi.spec.ts` reads from an uninitialised BsMulti in three
    // places. Without an id the source cannot be excluded from the hot-swap,
    // so the blob is written back to every writable including itself. That is
    // harmless (the store is content-addressed) and it must still answer.
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');
    const cache = new BsMem();
    const bsMulti = new BsMulti([
      { bs: slowStore(holder, SLOW_MS), priority: 0, read: true, write: true },
      { bs: cache, priority: 1, read: true, write: true },
    ]);
    // Deliberately NOT initialised.

    const { content } = await bsMulti.getBlob(blobId);
    expect(content.toString('utf8')).toBe('the bytes');
    expect(await cache.blobExists(blobId), 'not hot-swapped').toBe(true);
  }, 30_000);
});

// ...........................................................................
describe('BsMulti — the first set-aside source answers', () => {
  // Two sources are set aside and the FIRST of them answers, so the second
  // has to be discarded. For a stream that is not tidiness: an unread
  // `ReadableStream` leaves its source pushing bytes nobody will read.
  const buildBothSlowHolders = async () => {
    const holder = new BsMem();
    const { blobId } = await holder.setBlob('the bytes');
    const other = new BsMem();
    await other.setBlob('the bytes');

    const bsMulti = new BsMulti([
      { bs: slowStore(holder, SLOW_MS), priority: 0, read: true, write: false },
      { bs: slowStore(other, SLOW_MS), priority: 1, read: true, write: false },
      // Fast, open and empty — this is what arms the bound on both holders.
      { bs: new BsMem(), priority: 2, read: true, write: false },
    ]);
    await bsMulti.init();
    return { bsMulti, blobId };
  };

  // .........................................................................
  it('getBlobStream discards the stream from the set-aside source behind it', async () => {
    const { bsMulti, blobId } = await buildBothSlowHolders();
    const stream = await bsMulti.getBlobStream(blobId);
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value as Uint8Array).toString('utf8')).toContain(
      'the bytes',
    );
    await reader.cancel();
  }, 30_000);

  // .........................................................................
  it('blobExists stops at the first set-aside source that says yes', async () => {
    const { bsMulti, blobId } = await buildBothSlowHolders();
    expect(await bsMulti.blobExists(blobId)).toBe(true);
  }, 30_000);

  // .........................................................................
  it('getBlobProperties stops at the first set-aside source that answers', async () => {
    const { bsMulti, blobId } = await buildBothSlowHolders();
    expect((await bsMulti.getBlobProperties(blobId)).blobId).toBe(blobId);
  }, 30_000);
});
