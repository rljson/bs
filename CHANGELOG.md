# Changelog

## [Unreleased]

### Blobs are stored and moved as blocks — breaking

- **Every blob is cut into blocks** at boundaries the content decides
  (FastCDC with normalized chunking: 256 KB minimum, 1 MB average, 4 MB
  maximum). A block is identified by the SHA256 of its bytes and stored once,
  however many blobs contain it. A blob keeps its id: the SHA256 of its whole
  content.
- **Two versions of a file share their unchanged blocks.** A change moves only
  the boundaries next to it, whether bytes were overwritten, inserted or
  removed: on 24 MB, each of these left at most three new blocks.
- **`Bs` has five new calls:** `getBlobBlocks`, `getBlock`, `blockExists`,
  `setBlock`, `setBlobBlocks`. `getBlob`, ranges and `getBlobStream` are built
  on them (`readBlocks`, `streamBlocks`).
- **Over a socket only blocks travel, one per message.** `BsServer` and
  `BsPeerBridge` no longer answer `getBlob` or `setBlob`: a whole blob in one
  message was bounded by nothing but its file, and a socket closes the
  connection on a message above its cap. A blob of any size now crosses a
  socket whose cap is above 4 MB. `BsPeer` reads only the blocks a range
  touches, and `BsPeer.setBlob` sends only the blocks the other side lacks.
- **Nothing is trusted on arrival.** `BsPeer.getBlock` checks every block
  against its id, every stream checks the whole blob at its end, and
  `setBlobBlocks` refuses blocks that do not make the blob.
- **`BsMulti` reads block by block,** each block from the first source that
  holds it, keeps every block it read elsewhere, and stores a blob read whole
  in its writables. A ranged read no longer lands in the cache as a blob of
  its own.
- **A slow source costs one bound per read, not one per block.** A source set
  aside after `BLOB_SOURCE_TIMEOUT_MS` is asked after all others for
  `SLOW_SOURCE_MEMORY_MS` (30 s). It is still asked when nobody else answers.
- **Removed:** `BLOB_CHUNK_BYTES` and `BsPeerOptions.chunkBytes`. **New:**
  `BLOCK_MIN_BYTES`, `BLOCK_AVG_BYTES`, `BLOCK_MAX_BYTES`, `ContentId`,
  `blockEnd`, `forEachBlock`, `writeBlocks`, `readBlocks`, `streamBlocks`,
  `verifyBlock`, `verifyBlob`, `BlobBlock`, `BlobLayout`,
  `SLOW_SOURCE_MEMORY_MS`.
- **Both ends of a socket need this version.** An older peer neither asks for
  nor answers blocks.

### CLAUDE.md keeps this repo's own rules

- The rules every rljson repo shares (coverage, pinning, docs, releases,
  reviews) come with the rljson DNA: `doc/guides/rljson-guide.md` and
  `doc/guides/for-ai/rljson-review-guide.md`. `CLAUDE.md` no longer repeats
  them and no longer describes the old `gg one` workflow.

## [0.0.30]

### Developed in gg tickets

- **Developed in gg tickets.** The repo carries the rljson DNA (`@rljson/dna-rljson`): gg's `/gg-*` skills, the guides and the quick check (`.github/workflows/quick_check.yaml`).
- **Pull requests are checked by the quick check** (`gg one did commit`: every commit went through gg's local lint, tests and coverage). `Build and Test` runs on `main` after the merge.
- **`install-conformance-tests.js`** takes the conformance tests from a linked sibling checkout, which has no `dist/`, by running that checkout's `deploy-conformance-tests.js`.
- **`tsconfig.json` lists `node` in `types`:** TypeScript 6 includes no `@types` by default.
- **vitest also runs `test/**/*.test.ts`,** where gg's release writes the version test.
- **Dependencies raised to their newest versions** (TypeScript 6 among them).

### Releases go through gg

**What changed for contributors.** The CI no longer publishes:
`.github/workflows/publish.yml` is disabled, and a release happens only when
the owner runs `gg one do publish`, which merges first and uploads only what
`main` holds (`--merge-only` merges without a release). CLAUDE.md describes
the whole workflow through gg — `gg one do create ticket`, `gg one do
commit`, `gg one do push`, `gg one do publish`. The scripts gg replaces —
`create-branch.js`, `push-branch.js`, `wait-for-pr.js`, `publish-to-npm.js`,
`add-version-tag.js` — are removed.

## [0.0.27]

### Blob transfer streams instead of buffering

`BsPeer.getBlobStream` used to emit `getBlobStream` over the socket and expect a
`ReadableStream` back in the acknowledgement. That could never work: an ack
crosses the wire as data, and a stream is a live object with a reader, a queue
and a lock. On socket.io it arrived as `{}`. The method was on the interface,
implemented on every class, and covered by tests against a mock that handed the
object straight back — so a full green suite said nothing about it. Nothing
called it, which is the only reason the fault never surfaced.

It now builds the stream on the consumer's side out of ranged `getBlob` calls.
`DownloadBlobOptions.range` was already on the interface and `BsFs` was already
honouring it with a positioned read off disk; nobody was asking.

- **Added** `BLOB_CHUNK_BYTES` (4 MB) and `BsPeerOptions.chunkBytes`.
- **Removed** the `getBlobStream` wire event from `BsServer` and `BsPeerBridge`.
  Nothing emits it, and it could only ever answer wrongly.
- **Added** a conformance test that a multi-chunk blob arrives whole and in
  order, with a per-position pattern so a repeated or reordered chunk fails.

Why it matters: a whole-blob read cost the server the entire file in a Buffer
plus the parser's copy, and the consumer the same again. On the cloud EventHub
that was 487 MB of ArrayBuffers that never fell while the heap climbed to 926 MB,
until the process died of `Ineffective mark-compacts` — full collections
reclaiming 1.5 MB of 1020 MB, because none of it was garbage. It was work in
flight. A pull costs one chunk on each side.

It also lifts a hard ceiling: a blob larger than the 50 MB socket message cap
could not cross a socket at all, whatever the memory. `@rljson/fs-agent` carried
a note about one 63 MB file that pinned three of four nodes to a file the fourth
had deleted.

Pull-based deliberately: the consumer's pace is the flow control, so there is no
window, no credit protocol and no per-stream state on the server. Each pull is an
ordinary request that passes the hub's serving gate on its own, which is what
makes that gate bound chunk-sized work instead of blob-sized.

## [0.0.1]

Initial commit.
