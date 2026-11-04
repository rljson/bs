<!--
@license
Copyright (c) rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Blobs are stored and moved as content-defined blocks

## Motivation

- A blob was one lump. One changed byte meant the whole blob again: on the
  wire and in every store that kept it, with the old version beside it.
- Between stores, a read of a whole blob was one socket message. A socket
  closes the connection on a message above its cap, so the cap was a hidden
  limit on the size of a file.
- Ranged pulls of 4 MB had removed that limit for streams, but not for every
  path, and they gave a stored blob no parts that two versions could share.
- The goal: blobs of any size, and a small change that costs a small part.

## Strategy

- Cut every blob into blocks where its content decides (FastCDC with
  normalized chunking): 256 KB minimum, 1 MB average, 4 MB maximum.
- Identify a block by the SHA256 of its bytes and store it once, however
  many blobs contain it. A blob keeps its id: the hash of its whole content.
- Let only blocks cross a socket, one per message, and only the blocks the
  other side lacks.
- Check every block on arrival, and every streamed blob at its end.

## Blocks and their calls

- `forEachBlock` cuts content as it arrives and holds one block plus one
  incoming piece, whatever the blob's size. `blockEnd` finds a boundary with
  a 32-bit gear hash over a fixed table, so every store cuts alike.
- A change moves only the boundaries next to it: on 24 MB, overwriting
  100 bytes, inserting or removing 5 KB, or prepending 77 bytes each left at
  most three new blocks.
- `Bs` has five new calls: `getBlobBlocks`, `getBlock`, `blockExists`,
  `setBlock` and `setBlobBlocks`. `getBlob`, ranges and `getBlobStream` are
  built on them with `readBlocks` and `streamBlocks`.
- `setBlobBlocks` refuses blocks that do not hash to the blob's id, so a
  blob is only ever stored under the hash of its content.

## Over the wire

- `BsServer` and `BsPeerBridge` no longer answer `getBlob` or `setBlob`.
  `BsPeer` asks for the block list, then for the blocks; `BsPeer.setBlob`
  sends only blocks the other side does not hold yet.
- A stream asks for up to four blocks ahead (`BLOCK_READ_AHEAD`): with 10 ms
  per round trip, 60 MB took 625 ms one block at a time and 164 ms four
  ahead, holding at most four blocks.

## The multi-tier store

- `BsMulti` reads block by block, each from the first source that holds it,
  so a block a writable holds is never fetched again.
- It keeps every block it read elsewhere, and stores a blob read whole in
  its writables. A ranged read no longer lands in the cache as a blob of its
  own.
- A source that loses its turn is asked after all others for 30 s
  (`SLOW_SOURCE_MEMORY_MS`): a silent source costs one bound per read, not
  one per block.

## Result

- A 60 MB blob crosses a socket whose cap is 50 MB.
- A second version that differs in one kilobyte costs one or two blocks.
- 346 tests, 100 % coverage; the conformance suite checks the block calls
  for every store.

## Open Points

- Deleting a blob keeps its blocks: other blobs may contain them. Nothing
  removes blocks no blob uses any more.
- Both ends of a socket need this version: an older peer neither asks for
  nor answers blocks.
