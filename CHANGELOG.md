# Changelog

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
