# Changelog

## [Unreleased]

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
