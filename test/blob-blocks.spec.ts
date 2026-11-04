// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { hshBuffer } from '@rljson/hash';

import { describe, expect, it } from 'vitest';

import {
  BlobBlock,
  BLOCK_AVG_BYTES,
  BLOCK_MAX_BYTES,
  BLOCK_MIN_BYTES,
  blockEnd,
  forEachBlock,
  ContentId,
  readBlocks,
  streamBlocks,
  verifyBlob,
  verifyBlock,
  writeBlocks,
} from '../src';

/** Bytes that do not repeat, the same for the same seed. */
const noise = (size: number, seed: number): Buffer => {
  const bytes = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    bytes[i] = x & 0xff;
  }
  return bytes;
};

/** A stream that hands out `bytes` in pieces of `pieceSize`. */
const streamOf = (bytes: Buffer, pieceSize: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += pieceSize) {
        controller.enqueue(new Uint8Array(bytes.subarray(i, i + pieceSize)));
      }
      controller.close();
    },
  });

/** All blocks of some content, copied. */
const splitIntoBlocks = async (
  content: Buffer | string | ReadableStream<Uint8Array>,
): Promise<Buffer[]> => {
  const all: Buffer[] = [];
  await forEachBlock(content, async (block) => {
    all.push(Buffer.from(block));
  });
  return all;
};

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    parts.push(value);
  }
};

const ids = (blocks: Buffer[]) => blocks.map((b) => ContentId.of(b));

describe('blob-blocks', () => {
  const data = noise(24 * 1024 * 1024, 7);

  describe('blockEnd', () => {
    it('takes everything up to the minimum as one block', () => {
      expect(blockEnd(data, 0, BLOCK_MIN_BYTES)).toBe(BLOCK_MIN_BYTES);
      expect(blockEnd(data, 10, 20)).toBe(20);
    });

    it('never cuts a block above the maximum', () => {
      const flat = Buffer.alloc(3 * BLOCK_MAX_BYTES);
      expect(blockEnd(flat, 0, flat.length)).toBe(BLOCK_MAX_BYTES);
    });

    it('cuts the same bytes at the same place, wherever they start', () => {
      const end = blockEnd(data, 0, data.length);
      const shifted = Buffer.concat([Buffer.alloc(1000), data]);
      expect(blockEnd(shifted, 1000, shifted.length)).toBe(end + 1000);
    });
  });

  describe('forEachBlock', () => {
    it('cuts blocks between the minimum and the maximum, around the average', async () => {
      const blocks = await splitIntoBlocks(data);
      expect(Buffer.concat(blocks).equals(data)).toBe(true);
      for (const block of blocks.slice(0, -1)) {
        expect(block.length).toBeGreaterThanOrEqual(BLOCK_MIN_BYTES);
        expect(block.length).toBeLessThanOrEqual(BLOCK_MAX_BYTES);
      }
      const average = data.length / blocks.length;
      expect(average).toBeGreaterThan(BLOCK_AVG_BYTES * 0.6);
      expect(average).toBeLessThan(BLOCK_AVG_BYTES * 1.6);
    });

    it('cuts a stream exactly like the buffer, whatever its pieces', async () => {
      const whole = ids(await splitIntoBlocks(data));
      for (const pieceSize of [1000, 65_536, 5 * 1024 * 1024]) {
        const streamed = ids(await splitIntoBlocks(streamOf(data, pieceSize)));
        expect(streamed).toEqual(whole);
      }
    });

    it('cuts a string like its UTF-8 bytes', async () => {
      const text = 'grüße '.repeat(100_000);
      expect(ids(await splitIntoBlocks(text))).toEqual(
        ids(await splitIntoBlocks(Buffer.from(text, 'utf8'))),
      );
    });

    it('cuts content without any boundary at the maximum, also in exact pieces', async () => {
      const flat = Buffer.alloc(2 * BLOCK_MAX_BYTES);
      const blocks = await splitIntoBlocks(streamOf(flat, BLOCK_MAX_BYTES));
      expect(blocks.map((b) => b.length)).toEqual([
        BLOCK_MAX_BYTES,
        BLOCK_MAX_BYTES,
      ]);
    });

    it('gives nothing for empty content', async () => {
      expect(await splitIntoBlocks(Buffer.alloc(0))).toEqual([]);
      expect(await splitIntoBlocks(streamOf(Buffer.alloc(0), 10))).toEqual([]);
    });

    it('keeps the blocks around a change: overwritten, inserted, removed', async () => {
      const before = new Set(ids(await splitIntoBlocks(data)));
      const middle = data.length / 2;
      const variants = {
        overwritten: Buffer.concat([
          data.subarray(0, middle),
          noise(100, 1),
          data.subarray(middle + 100),
        ]),
        inserted: Buffer.concat([
          data.subarray(0, middle),
          noise(5000, 2),
          data.subarray(middle),
        ]),
        removed: Buffer.concat([
          data.subarray(0, middle),
          data.subarray(middle + 5000),
        ]),
        prepended: Buffer.concat([noise(77, 3), data]),
      };
      for (const variant of Object.values(variants)) {
        const after = ids(await splitIntoBlocks(variant));
        const changed = after.filter((id) => !before.has(id));
        expect(changed.length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe('ContentId', () => {
    it('gives the id @rljson/hash gives, at the padding edges and fed in pieces', () => {
      for (const size of [0, 1, 55, 56, 63, 64, 65, 1000]) {
        const bytes = noise(size, size + 1);
        expect(ContentId.of(bytes)).toBe(hshBuffer(bytes));
        const pieces = new ContentId()
          .update(bytes.subarray(0, size / 3))
          .update(bytes.subarray(size / 3));
        expect(pieces.digest()).toBe(hshBuffer(bytes));
      }
    });

    it('has an example', () => {
      expect(ContentId.example().digest()).toBe(
        hshBuffer(Buffer.from('example')),
      );
    });
  });

  describe('writeBlocks', () => {
    it('hands out every block and returns the id of the whole content', async () => {
      const put: Array<{ block: BlobBlock; bytes: Buffer }> = [];
      const layout = await writeBlocks(
        streamOf(data, 65_536),
        async (block, bytes) => {
          put.push({ block, bytes: Buffer.from(bytes) });
        },
      );
      expect(layout.blobId).toBe(hshBuffer(data));
      expect(layout.size).toBe(data.length);
      expect(layout.blocks).toEqual(put.map((p) => p.block));
      for (const { block, bytes } of put) {
        expect(block).toEqual({
          blockId: hshBuffer(bytes),
          size: bytes.length,
        });
      }
    });
  });

  describe('reading', () => {
    const small = Buffer.from('0123456789abcdefghij');
    const blocks: BlobBlock[] = [
      { blockId: ContentId.of(small.subarray(0, 7)), size: 7 },
      { blockId: ContentId.of(small.subarray(7, 15)), size: 8 },
      { blockId: ContentId.of(small.subarray(15)), size: 5 },
    ];
    const store = new Map(
      [small.subarray(0, 7), small.subarray(7, 15), small.subarray(15)].map(
        (b) => [ContentId.of(b), b],
      ),
    );
    const read: string[] = [];
    const readBlock = async (blockId: string) => {
      read.push(blockId);
      return store.get(blockId)!;
    };

    it('reads a range from the blocks it touches only', async () => {
      read.length = 0;
      expect((await readBlocks(blocks, readBlock)).equals(small)).toBe(true);
      expect(read).toHaveLength(3);

      read.length = 0;
      const range = { start: 8, end: 12 };
      expect((await readBlocks(blocks, readBlock, range)).toString()).toBe(
        '89ab',
      );
      expect(read).toEqual([blocks[1].blockId]);

      expect(
        (await readBlocks(blocks, readBlock, { start: 5 })).toString(),
      ).toBe('56789abcdefghij');
      expect((await readBlocks(blocks, readBlock, { start: 30 })).length).toBe(
        0,
      );
    });

    it('streams the blocks and verifies the whole content', async () => {
      const blobId = ContentId.of(small);
      let completed = false;
      const stream = streamBlocks(blobId, blocks, readBlock, async () => {
        completed = true;
      });
      expect((await readAll(stream)).equals(small)).toBe(true);
      expect(completed).toBe(true);
    });

    it('fails a stream whose blocks do not make the blob', async () => {
      const stream = streamBlocks('not-the-id', blocks, readBlock);
      await expect(readAll(stream)).rejects.toThrow(
        "Blocks of blob 'not-the-id' make",
      );
    });

    it('verifies blocks and blobs', async () => {
      expect(() =>
        verifyBlock(blocks[0].blockId, small.subarray(0, 7)),
      ).not.toThrow();
      expect(() => verifyBlock(blocks[0].blockId, small)).toThrow(
        `Block '${blocks[0].blockId}' arrived as`,
      );
      expect(await verifyBlob(ContentId.of(small), blocks, readBlock)).toBe(20);
      await expect(verifyBlob('not-the-id', blocks, readBlock)).rejects.toThrow(
        "Blocks of blob 'not-the-id' make",
      );
    });
  });
});
