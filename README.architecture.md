<!--
@license
Copyright (c) 2026 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/bs - Architecture Documentation

Deep dive into the architectural design, implementation patterns, and internal workings of the rljson blob storage system.

## Table of Contents

1. [Overview](#overview)
2. [Core Design Principles](#core-design-principles)
3. [Component Architecture](#component-architecture)
4. [Content-Addressable Storage](#content-addressable-storage)
5. [Network Architecture](#network-architecture)
6. [PULL vs PUSH Architecture](#pull-vs-push-architecture)
7. [Multi-Tier Storage](#multi-tier-storage)
8. [Socket Abstraction Layer](#socket-abstraction-layer)
9. [Implementation Details](#implementation-details)
10. [Design Patterns](#design-patterns)
11. [Performance Optimization](#performance-optimization)
12. [Testing Strategy](#testing-strategy)

## Overview

`@rljson/bs` implements a content-addressable blob storage system with a layered architecture designed for flexibility, performance, and type safety. The system follows a modular design where each component has a single responsibility and can be composed with others to create complex storage hierarchies.

### System Goals

1. **Content Addressability**: Every blob is identified by its SHA256 hash
2. **Automatic Deduplication**: Identical content stored only once
3. **Composability**: Components can be combined to create multi-tier architectures
4. **Network Transparency**: Local and remote storage use the same interface
5. **Type Safety**: Full TypeScript support with comprehensive types
6. **Testability**: 100% test coverage with comprehensive test utilities

## Core Design Principles

### 1. Interface-First Design

All storage implementations conform to the `Bs` interface, ensuring uniform behavior:

```typescript
export interface Bs {
  setBlob(content: Buffer | string | ReadableStream): Promise<BlobProperties>;
  getBlob(blobId: string, options?: DownloadBlobOptions): Promise<{ content: Buffer; properties: BlobProperties }>;
  getBlobStream(blobId: string): Promise<ReadableStream>;
  deleteBlob(blobId: string): Promise<void>;
  blobExists(blobId: string): Promise<boolean>;
  getBlobProperties(blobId: string): Promise<BlobProperties>;
  listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult>;
  generateSignedUrl(blobId: string, expiresIn: number, permissions?: 'read' | 'delete'): Promise<string>;
}
```

**Benefits:**
- Implementations can be swapped without changing client code
- Easy to add new storage backends
- Consistent behavior across all implementations
- Simplified testing with mocks

### 2. Content-Addressable Storage

Blobs are identified by SHA256 hash of their content, not by user-defined names.

**Advantages:**
- **Automatic Deduplication**: Same content = same ID
- **Data Integrity**: Hash serves as checksum
- **Location Independence**: Content can be verified anywhere
- **Efficient Caching**: Content can be cached safely by hash

**Trade-offs:**
- Cannot choose blob IDs
- Metadata must be stored separately
- Changing content changes ID

### 3. Flat Storage Pool

No hierarchy, containers, or folders at the Bs level:

```
Traditional:              Content-Addressable:
├── container1/           All blobs in flat pool:
│   ├── file1.txt        ├── dffd6021bb2bd5b0...
│   └── file2.txt        ├── a591a6d40bf420...<br/>└── container2/           └── e3b0c44298fc1c1...
    └── file3.txt
```

**Benefits:**
- Simpler implementation
- Natural deduplication
- No path traversal issues
- Efficient lookups

**Metadata Storage:**
Organizational metadata (folders, tags, filenames) is stored separately, typically in `@rljson/io` (table storage).

### 4. Composition Over Inheritance

Complex behaviors are achieved by composing simple components:

```typescript
// Composition: BsMulti wraps multiple Bs instances
const bs = new BsMulti([
  { bs: localCache, priority: 0 },   // Simple BsMem
  { bs: remotePeer, priority: 1 },   // Simple BsPeer
]);

// Not inheritance: class BsCachedRemote extends Bs
```

## Component Architecture

### Layered Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Application Layer                     │
│              (Your code using @rljson/bs)               │
└──────────────────┬──────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────┐
│                 Composition Layer                        │
│                                                          │
│  ┌─────────┐    Combines multiple storage backends     │
│  │BsMulti  │    - Priority-based reads                 │
│  │         │    - Parallel writes                      │
│  └────┬────┘    - Hot-swapping/caching                │
│       │                                                 │
└───────┼─────────────────────────────────────────────────┘
        │
        ├──────┬──────┬──────┬──────┐
        │      │      │      │      │
┌───────▼──┐ ┌─▼────┐ ┌────▼┐ ┌────▼─────┐
│  BsMem   │ │BsPeer│ │...  │ │  Custom  │  <- Storage Layer
│ (local)  │ │(net) │ │     │ │   Impl   │
└──────────┘ └──┬───┘ └─────┘ └──────────┘
                │
        ┌───────▼────────┐
        │ Socket Layer   │  <- Transport Layer
        │ (abstraction)  │
        └───────┬────────┘
                │
        ┌───────▼────────┐
        │  BsServer      │  <- Server Layer
        │  BsPeerBridge  │
        └────────────────┘
```

### Component Responsibilities

#### 1. **Bs Interface** (`bs.ts`)

The core interface that all implementations must follow.

**Responsibilities:**
- Define the contract for blob storage operations
- Specify type definitions for parameters and return values
- Document expected behavior

**Key Types:**
- `BlobProperties`: Metadata about a blob
- `DownloadBlobOptions`: Options for retrieving blobs
- `ListBlobsOptions`: Options for listing blobs
- `ListBlobsResult`: Result structure for list operations

#### 2. **BsMem** (`bs-mem.ts`)

In-memory implementation of the Bs interface.

**Responsibilities:**
- Store blobs in a Map (memory)
- Calculate SHA256 hashes
- Handle deduplication automatically
- Provide fast, ephemeral storage

**Internal Structure:**
```typescript
class BsMem implements Bs {
  private readonly blobs = new Map<string, StoredBlob>();

  // StoredBlob structure:
  interface StoredBlob {
    content: Buffer;
    properties: BlobProperties;
  }
}
```

**Key Operations:**
- `setBlob`: Hash content → Check if exists → Store if new
- `getBlob`: Lookup by blobId → Return content + properties
- `listBlobs`: Convert Map entries → Sort → Filter → Paginate

#### 3. **BsPeer** (`bs-peer.ts`)

Client-side implementation that accesses remote storage via socket.

**Responsibilities:**
- Translate Bs method calls to socket messages
- Handle async socket communication
- Manage connection state
- Convert between local types and wire format

**Architecture Pattern:**
```
BsPeer (Client)                    BsServer (Remote)
     │                                   │
     │  socket.emit('setBlob', ...)    │
     ├──────────────────────────────────>│
     │                                   │ storage.setBlob(...)
     │  callback(null, result)          │
     │<──────────────────────────────────┤
     │                                   │
```

**Connection Lifecycle:**
1. `init()`: Connect socket and wait for 'connect' event
2. Operations: Send requests via socket, receive callbacks
3. `close()`: Disconnect socket and wait for 'disconnect' event

**Error Handling:**
- Uses error-first callbacks: `(error, result)`
- Network errors propagated as promise rejections
- Connection state tracked via `isOpen` property

#### 4. **BsServer** (`bs-server.ts`)

Server-side component that exposes a Bs instance over sockets.

**Responsibilities:**
- Accept socket connections from multiple clients
- Route socket messages to underlying Bs methods
- Translate results back to socket responses
- Handle multiple concurrent clients

**Socket lifecycle / `removeSocket`:** the CRUD listeners registered in
`addSocket` are retained by reference (per socket) so that `removeSocket`
actually `socket.off()`s them. This matters when a single socket is shared by
more than one server (e.g. a hub multiplexing several routes): without it, the
blob listeners kept firing after removal, leaking handlers and executing every
blob request once per server. `removeSocket` is idempotent — removing a socket
twice, or one that was never added, is a no-op.

**Transport Layer Generation:**
```typescript
private _generateTransportLayer(bs: Bs) {
  return {
    setBlob: (content) => bs.setBlob(content),
    getBlob: (blobId, options) => bs.getBlob(blobId, options),
    // ... map all Bs methods
  };
}
```

**Multi-Client Support:**
```typescript
// Each client has its own socket
await server.addSocket(clientSocket1);
await server.addSocket(clientSocket2);

// Clients share the same underlying Bs instance
// Content-addressable nature ensures consistency
```

#### 5. **BsPeerBridge** (`bs-peer-bridge.ts`)

**CRITICAL: Read-Only PULL Architecture**

Exposes local storage for remote access (server pulls from client).

**Responsibilities:**
- Listen for socket events from server
- Translate events to Bs method calls on local storage
- **Only expose READ operations** (PULL pattern)
- Use error-first callback pattern

**Architectural Pattern:**
```
Client                              Server
┌─────────────────┐                 ┌──────────────────┐
│  Local Storage  │                 │   Server Bs      │
│    (BsMem)      │                 │                  │
└────────┬────────┘                 └────────┬─────────┘
         │                                    │
         │                                    │
    ┌────▼─────────┐                    ┌────▼────────┐
    │BsPeerBridge  │◄───Socket (READ)───│  BsPeer     │
    │ (Exposes     │                    │ (Requests)  │
    │  READ only)  │                    │             │
    └──────────────┘                    └─────────────┘

Client exposes local storage for SERVER to PULL from (read-only)
Server CANNOT push writes to client
```

**Read-Only Methods Exposed:**
- `getBlob` - Read blob content, whole or by byte range
- `blobExists` - Check existence
- `getBlobProperties` - Get metadata
- `listBlobs` - List available blobs

**NOT Exposed (Write Operations):**
- `setBlob` - Would allow server to write to client
- `deleteBlob` - Would allow server to delete from client
- `generateSignedUrl` - Management operation

**Why `getBlobStream` is NOT a wire method**

It used to be, and it could never answer. An acknowledgement crosses the wire as
data; a `ReadableStream` is a live object with a reader, a queue and a lock. On
socket.io it arrived as `{}`.

`BsPeer.getBlobStream` builds the stream on its own side, one `getBlock` at a
time (see [Blocks](#blocks)). Pull-based deliberately: the consumer's pace is
the flow control, so there is no window, no credit protocol and no per-stream
state on the server. Each block is an ordinary request, which also means each
one passes a hub's serving gate on its own — that is what makes the gate bound
block-sized work instead of blob-sized. `getBlob` is not a wire method either:
a whole blob in one message cannot exceed the transport's message cap.

#### 6. **BsMulti** (`bs-multi.ts`)

Multi-tier storage that composes multiple Bs instances.

**Responsibilities:**
- Manage multiple storage backends with priorities
- Route reads to highest priority readable
- Write to all writable stores in parallel
- Implement hot-swapping (cache population)
- Merge results from multiple stores

**Priority System:**
```typescript
type BsMultiBs = {
  bs: Bs;
  id?: string;
  priority: number;  // Lower number = higher priority
  read: boolean;     // Can read from this store
  write: boolean;    // Can write to this store
};
```

**Read Strategy (block by block):**
1. Ask the readables for the blob's block list, in priority order
2. Ask for each block the same way: a block a writable already holds is never
   fetched again, so a new version of a file costs only its changed blocks
3. Keep every block read elsewhere in every writable except its source
4. Once a blob was read whole (`getBlob` without a range, or a stream read to
   its end), store its block list in every writable that lacks it

A source that does not answer within `BLOB_SOURCE_TIMEOUT_MS` while another
could is set aside — asked again only when nobody else answered — and asked
after all others for `SLOW_SOURCE_MEMORY_MS`, so a silent source costs one
bound per read rather than one per block.

**Write Strategy:**
1. Collect all writable stores
2. Write to all in parallel using `Promise.all`
3. All writes must succeed (or error)
4. Content-addressable ensures consistency

**List Strategy (Deduplication):**
```typescript
async listBlobs(): Promise<ListBlobsResult> {
  // Query all readable stores in parallel
  const allResults = await Promise.all(
    this.readables.map(({ bs }) => bs.listBlobs())
  );

  // Deduplicate by blobId (Set)
  const uniqueBlobs = new Map<string, BlobProperties>();
  for (const result of allResults) {
    for (const blob of result.blobs) {
      uniqueBlobs.set(blob.blobId, blob);
    }
  }

  return { blobs: Array.from(uniqueBlobs.values()) };
}
```

## Content-Addressable Storage

### SHA256 Hashing

Every blob and every block is identified by the SHA256 of its bytes, in
base64url, cut to 22 characters — the id `@rljson/hash`'s `hshBuffer` gives.
`ContentId` computes it incrementally, so a stream never has to be held
whole:

```typescript
import { ContentId } from '@rljson/bs';

ContentId.of(bytes); // the id of some bytes
new ContentId().update(first).update(rest).digest(); // the same, in pieces
```

### Blocks

**Every blob is stored as blocks.** `forEachBlock` cuts content at
boundaries the content decides — FastCDC with normalized chunking, a 32-bit
gear hash over a fixed table:

| | |
| --- | --- |
| `BLOCK_MIN_BYTES` | 256 KB — only the last block of a blob may be smaller |
| `BLOCK_AVG_BYTES` | 1 MB — what the boundaries aim for |
| `BLOCK_MAX_BYTES` | 4 MB — the largest block, and the largest message a blob needs |

A change inside a file moves only the boundaries next to it — whether bytes
were overwritten, inserted or removed — so two versions of a file share
every block the change did not touch. Measured on 24 MB of noise: a 100-byte
overwrite, a 5 KB insertion, a 5 KB removal and 77 bytes prepended each leave
at most three new blocks.

A blob is its block list: `BlobLayout { blobId, size, blocks }`, where
`blobId` is still the hash of the whole content. A store keeps each block
once, however many blobs contain it:

```text
setBlob(content)
  └─ writeBlocks(content, putBlock)
       ├─ forEachBlock: cut, one block at a time
       ├─ ContentId.of(block) → blockId; putBlock stores it unless held
       └─ ContentId over everything → blobId
  └─ store the block list under blobId
```

The sizes, the gear table and the masks decide every boundary. Changing them
breaks nothing — a reader always follows the block list of the store it
reads from — but blocks cut before the change are no longer shared with
blocks cut after it.

### The block calls of `Bs`

| Call | |
| --- | --- |
| `getBlobBlocks(blobId)` | the blob's blocks, in order |
| `getBlock(blockId)` | one block's bytes |
| `blockExists(blockId)` | whether the store holds a block |
| `setBlock(content)` | store one block, id from its bytes |
| `setBlobBlocks(blobId, blocks)` | store a blob from held blocks; refused unless they hash to `blobId` |

`getBlob`, `getBlobStream` and ranges are built on them with `readBlocks`
(only the blocks a range touches are read) and `streamBlocks` (one block at
a time; the stream fails at its end unless the bytes hash to `blobId`).
Deleting a blob deletes its block list; its blocks stay, other blobs may
contain them.

### Content Verification

Nothing is trusted on arrival: `BsPeer.getBlock` checks every block against
its id (`verifyBlock`), every stream checks the whole blob at its end, and
`setBlobBlocks` refuses blocks that do not make the blob (`verifyBlob`). A
blob is only ever stored under the hash of its content.

## Network Architecture

### Socket Abstraction

The `Socket` interface abstracts network transport:

```typescript
export interface Socket {
  connected: boolean;
  disconnected: boolean;
  connect(): void;
  disconnect(): void;
  on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  emit(eventName: string | symbol, ...args: any[]): boolean | this;
  off(eventName: string | symbol, listener: (...args: any[]) => void): this;
  removeAllListeners(eventName?: string | symbol): this;
}
```

**Implementations:**
- `SocketMock`: In-process mock for testing (synchronous)
- `PeerSocketMock`: Direct Bs invocation (testing without network)
- `DirectionalSocketMock`: Bidirectional socket pair (testing)
- **Production**: Use Socket.IO, WebSocket, or custom implementation

### Protocol

**Bytes cross only as blocks, one block per message.** A whole blob in one
message is bounded by nothing but its file, and a socket closes the
connection on a message above its cap. So `BsServer` answers
`getBlobBlocks`, `getBlock`, `blockExists`, `setBlock`, `setBlobBlocks`,
`getBlobProperties`, `blobExists`, `listBlobs`, `deleteBlob` and
`generateSignedUrl` — and neither `getBlob` nor `setBlob`. `BsPeerBridge`
answers the reads among them.

**Message Format (Socket Events):**
```
Event: <methodName>
Args: [...methodArgs, callback]

Example:
socket.emit('getBlock', blockId, (error, bytes) => { … });
```

**Error-First Callbacks:**
```typescript
callback(error: Error | null, result?: T);
```

### Client-Server Flow

**Reading a blob (`BsPeer.getBlobStream`):**
```
1. emit('getBlobBlocks', blobId)        → the block list
2. per block, as the consumer reads on:
   emit('getBlock', blockId)           → ≤ 4 MB, checked against blockId
3. at the end: the bytes must hash to blobId, or the stream fails
```

**Storing a blob (`BsPeer.setBlob`):**
```
1. cut the content into blocks here
2. per block: emit('blockExists') — and emit('setBlock') only if missing
3. emit('setBlobBlocks', blobId, blocks) → refused unless they make blobId
```

The consumer's pace is the flow control: the next block is asked for when
the consumer reads on, so neither side holds more than a block.

### Request Timeouts & Fail-Fast (BsPeer)

A socket `emit()` has no built-in upper bound: if the remote peer is dead or
partitioned but the local `Socket` never fires a `disconnect` event (e.g. a
half-open TCP connection), the ack callback simply never arrives and the
returned promise hangs forever. `BsPeer` guards against this with two
independent mechanisms:

**1. Per-request timeout**

Every request method (`setBlob`, `getBlob`, `deleteBlob`, `blobExists`,
`getBlobProperties`, `listBlobs`, `generateSignedUrl`) wraps its
ack-waiting promise with a private `_withTimeout()` helper:

```typescript
private _withTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  if (this._requestTimeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${this._requestTimeoutMs}ms on '${operation}'`));
    }, this._requestTimeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer!);
  });
}
```

- **Default**: `30_000` ms.
- **Configurable**: pass `{ requestTimeoutMs }` as the second constructor
  argument — `new BsPeer(socket, { requestTimeoutMs: 5_000 })`. Omitting the
  options object (or the field) keeps the default, so existing
  `new BsPeer(socket)` call sites are unaffected.
- **Disabled**: any value `<= 0` bypasses the race entirely (useful for tests
  that intentionally exercise slow paths).
- The timer is always cleared in `finally`, whether the request settles or
  times out, so no dangling timers leak.
- Mirrors the equivalent `_withTimeout` pattern in `@rljson/io`'s `IoPeer`,
  with the message wording adapted (`Timeout after <ms>ms on '<method>'`).

**2. Fail-fast on a known-closed socket**

`BsPeer` already tracks connection state via `isOpen` (flipped by the
`connect`/`disconnect` socket listeners registered in `init()`). Every
request method now checks `isOpen` **before** emitting:

```typescript
if (!this.isOpen) {
  return Promise.reject(new Error('BsPeer: socket closed'));
}
```

This avoids paying the full timeout cost when the disconnect is already
known — e.g. after `close()` was called, or once a `disconnect` event has
fired. The 30s timeout only applies to peers that are *silently* dead
(socket layer still reports connected, but nothing ever acks); a peer that
is known to be closed fails immediately.

## PULL vs PUSH Architecture

### PULL Architecture (Recommended)

**Pattern: Server pulls data from client when needed**

```
┌─────────┐                    ┌────────┐
│ Client  │                    │ Server │
│         │                    │        │
│  Local  │◄────READ ONLY──────│  Peer  │
│  Store  │    (BsPeerBridge)  │        │
│         │                    │        │
└─────────┘                    └────────┘

Server requests: "Give me blob X"
Client responds: "Here is blob X"
Server CANNOT push data to client
```

**Implementation:**
```typescript
// Client exposes local storage via BsPeerBridge (read-only)
const bridge = new BsPeerBridge(localStorage, socket);
bridge.start();  // Only read operations exposed

// Server pulls from client
const peer = new BsPeer(socket);
const { content } = await peer.getBlob(blobId);  // ✅ Can read
// await peer.setBlob('data');  // ❌ Would fail if bridge is read-only on client
```

**Benefits:**
- ✅ Client controls its data
- ✅ Server cannot inject malicious content
- ✅ Clear unidirectional data flow
- ✅ Matches real-world HTTP patterns (server pulls via GET)

### PUSH Architecture (Anti-Pattern for BsPeerBridge)

**Pattern: Server pushes data to client (NOT RECOMMENDED)**

```
┌─────────┐                    ┌────────┐
│ Client  │                    │ Server │
│         │                    │        │
│  Local  │◄────READ/WRITE─────│  Peer  │
│  Store  │    (Full Access)   │        │
│         │                    │        │
└─────────┘                    └────────┘

Server command: "Store this blob"
Client stores: "Blob stored"
Server can write to client ❌
```

**Why NOT to expose writes in BsPeerBridge:**
- ❌ Security risk: Server can push malicious data
- ❌ Unclear data ownership
- ❌ Violates principle of least privilege
- ❌ Client loses control over its storage

**Correct Alternative:**
If client wants to send data to server, use `BsPeer` for client-to-server writes:

```typescript
// Client pushes to server using BsPeer
const serverPeer = new BsPeer(socketToServer);
await serverPeer.setBlob('data');  // Client-initiated write to server
```

### Comparison with IoPeerBridge

`BsPeerBridge` follows the same read-only pattern as `IoPeerBridge` from `@rljson/io`:

**IoPeerBridge (Table Storage):**
```typescript
// Only exposes reads:
- readRows      // ✅ READ
- tableExists   // ✅ READ
- rawTableCfgs  // ✅ READ
// NOT: insertRow, updateRow, deleteRow
```

**BsPeerBridge (Blob Storage):**
```typescript
// Only exposes reads:
- getBlob           // ✅ READ
- blobExists        // ✅ READ
- getBlobProperties // ✅ READ
- listBlobs         // ✅ READ
// NOT: setBlob, deleteBlob, generateSignedUrl
```

**Consistency:** Both use PULL architecture for client-server interactions.

## Multi-Tier Storage

### Hierarchical Storage Management (HSM)

BsMulti implements a form of HSM with automatic tier management:

```
Priority 0 (Highest)
├─ Fast local cache (BsMem)
│  └─ Small, fast, volatile

Priority 1
├─ Network storage (BsPeer)
│  └─ Larger, slower, persistent

Priority 2 (Lowest)
├─ Backup/Archive (Read-only)
   └─ Largest, slowest, persistent
```

### Read Path: Block by Block, Keeping Every Block

```
1. Request: getBlob(blobId) or getBlobStream(blobId)

2. getBlobBlocks(blobId): Priority 0, then 1, then 2 — first answer wins

3. For each block:
   ├─ Priority 0 holds it: read it there ✅
   └─ else the next priority that holds it:
      ├─ read it (checked against its id by BsPeer)
      └─ keep it in every writable except the source

4. Read whole: store the block list in every writable that lacks it
```

A new version of a file that shares most of its blocks with one already in
Priority 0 costs only the blocks Priority 0 lacks.

**Code:**
```typescript
async getBlobStream(blobId: string): Promise<ReadableStream<Uint8Array>> {
  const blocks = await this.getBlobBlocks(blobId);
  return streamBlocks(
    blobId,
    blocks,
    (blockId) => this.getBlock(blockId), // cascade + keep
    () => this._keep(blobId, blocks), // store the blob once read whole
  );
}
```

### Write Path (Parallel Replication)

```
1. Request: setBlob(content)

2. Collect all writable stores
   ├─ Priority 0: Local cache (write=true)
   ├─ Priority 1: Network storage (write=true)
   └─ Priority 2: Backup (write=false) ← Skip

3. Write to all writables in parallel
   ├─ Promise.all([
   │    cache.setBlob(content),
   │    network.setBlob(content),
   │  ])

4. All must succeed or error propagates
   ├─ Content-addressable ensures same blobId everywhere
   └─ Deduplication prevents storage waste
```

### List Operations (Deduplication)

```
1. Request: listBlobs()

2. Query all readable stores in parallel
   ├─ Promise.all([
   │    cache.listBlobs(),
   │    network.listBlobs(),
   │    backup.listBlobs(),
   │  ])

3. Deduplicate results by blobId
   ├─ Use Map<blobId, BlobProperties>
   └─ Content-addressable means same blobId = same content

4. Return merged list
```

### Closed-Member Skipping

`BsMulti` iterates its readables **sequentially**, stopping at the first
success (`getBlob`, `getBlobStream`, `blobExists`, `getBlobProperties`,
`listBlobs`, `generateSignedUrl`) — `getBlobStream` included, though it is no
longer a wire method: `BsMulti` delegates to a member's own implementation, and
on a `BsPeer` that one is built locally from ranged `getBlob` pulls — it never uses `Promise.allSettled`. That
makes it safe to skip a member outright instead of calling it and waiting
for a rejection (or, without `BsPeer`'s request timeout, hanging forever):

```typescript
private _isClosed(bs: Bs): boolean {
  return (bs as { isOpen?: boolean }).isOpen === false;
}
```

- A member is skipped when its `isOpen` flag is present and `=== false`
  (currently only `BsPeer` exposes `isOpen`).
- Members without an `isOpen` flag (`BsMem` and similar in-process
  implementations) are always treated as open — `undefined !== false`.
- Skipping preserves the existing first-success / error-aggregation style of
  each method (e.g. the `Blob not found: <id>` error once every open member
  has been tried and missed).
- **Distinct topology-failure error**: if *every* readable is closed, none of
  them are actually queried, so there is no "not found" signal to report.
  Reporting `Blob not found` in that situation would be misleading — it
  would look like a verified absence rather than an unreachable topology.
  Instead, `BsMulti` throws a distinct `All readable Bs instances are
  closed` error, letting callers tell "definitely absent" apart from
  "couldn't check". `blobExists` follows the same rule: it only returns
  `false` once every open member has been asked and missed; if all
  readables are closed it throws rather than returning a potentially
  misleading `false`.

## Socket Abstraction Layer

### Design Philosophy

The Socket interface abstracts the transport layer, allowing:

1. **Different transports**: WebSocket, Socket.IO, custom protocols
2. **Testing**: In-process mocks without network
3. **Flexibility**: Swap implementations without changing Bs code

### Mock Implementations

#### SocketMock (Basic)

Simulates a socket with EventEmitter-like behavior:

```typescript
class SocketMock implements Socket {
  private _listeners: Map<string | symbol, Array<(...args: any[]) => void>>;

  emit(eventName: string | symbol, ...args: any[]): boolean {
    const listeners = this._listeners.get(eventName) || [];
    for (const listener of listeners) {
      listener(...args);
    }
    return listeners.length > 0;
  }
}
```

**Use:** General-purpose testing, client-server simulation.

#### PeerSocketMock (Direct)

Directly invokes Bs methods without socket events:

```typescript
class PeerSocketMock implements Socket {
  constructor(private _bs: Bs) {}

  emit(eventName: string, ...args: any[]): this {
    const callback = args[args.length - 1];
    const methodArgs = args.slice(0, -1);

    // Direct method invocation
    this._bs[eventName](...methodArgs)
      .then(result => callback(null, result))
      .catch(error => callback(error, null));

    return this;
  }
}
```

**Use:** Testing BsPeer without BsServer, fastest mock.

**Dead-peer simulation:** when `connected === false`, `emit()` swallows the
call and never invokes the ack callback — mirroring a socket whose remote
side has vanished without a clean `disconnect`. This is the scenario
`BsPeer`'s request timeout exists for. Because calling `disconnect()` also
fires the `disconnect` listeners (which flip `BsPeer.isOpen` to `false` and
trigger the *fail-fast* path instead of the timeout path), tests that want
to exercise the timeout in isolation use `setConnected(false)`, a test-facing
helper that flips the `connected` flag without emitting `connect`/
`disconnect` events:

```typescript
const socket = new PeerSocketMock(bsMem);
const peer = new BsPeer(socket, { requestTimeoutMs: 50 });
await peer.init(); // isOpen === true, connected === true

socket.setConnected(false); // peer looks open, but goes silent
await expect(peer.getBlob('id')).rejects.toThrow("Timeout after 50ms on 'getBlob'");
```

#### DirectionalSocketMock (Bidirectional)

Creates a pair of connected sockets:

```typescript
const socket1 = new DirectionalSocketMock();
const socket2 = new DirectionalSocketMock();

socket1.setPeer(socket2);
socket2.setPeer(socket1);

// Events on socket1 trigger listeners on socket2
socket1.emit('event', 'data');  // socket2 receives 'event'
```

**Use:** Testing full client-server interaction, network simulation.

### Production Integration

**Socket.IO Example:**
```typescript
import { io, Socket as SocketIOSocket } from 'socket.io-client';

// Wrap Socket.IO in Socket interface
class SocketIOAdapter implements Socket {
  constructor(private _socket: SocketIOSocket) {}

  get connected() { return this._socket.connected; }
  get disconnected() { return this._socket.disconnected; }
  connect() { this._socket.connect(); }
  disconnect() { this._socket.disconnect(); }
  on(event, listener) { this._socket.on(event, listener); return this; }
  emit(event, ...args) { this._socket.emit(event, ...args); return this; }
  off(event, listener) { this._socket.off(event, listener); return this; }
  removeAllListeners(event) { this._socket.removeAllListeners(event); return this; }
}

// Use with BsPeer
const socket = new SocketIOAdapter(io('http://server'));
const peer = new BsPeer(socket);
await peer.init();
```

## Implementation Details

### Error Handling

**Error Propagation:**
```typescript
// BsMem: Synchronous errors
if (!this.blobs.has(blobId)) {
  throw new Error(`Blob not found: ${blobId}`);
}

// BsPeer: Async errors from callbacks
socket.emit('getBlob', blobId, (error, result) => {
  if (error) reject(error);
  else resolve(result);
});

// BsMulti: Fallback on errors
for (const readable of this.readables) {
  try {
    return await readable.bs.getBlob(blobId);
  } catch (e) {
    // Try next priority
    continue;
  }
}
throw new Error('Blob not found in all stores');
```

**Error Types:**
- `Blob not found`: blobId doesn't exist
- `No readable/writable Bs available`: BsMulti configuration error
- `All readable Bs instances are closed`: BsMulti topology failure — every
  readable member's `isOpen` is `false`, so nothing was actually queried
  (distinct from `Blob not found`, which means every member *was* queried
  and missed)
- `BsPeer: socket closed`: fail-fast rejection when a request is made while
  `BsPeer.isOpen === false`
- `Timeout after <ms>ms on '<method>'`: a `BsPeer` request's ack never
  arrived within `requestTimeoutMs`
- `Method not found`: BsPeerBridge received unknown method
- Network errors: Socket connection failures

### Stream Handling

Local stores hand out a stream over their own bytes. `BsPeer` is the exception —
it has no bytes of its own, so it pulls them; see **Why `getBlobStream` is NOT a
wire method** above.

**Buffer to Stream Conversion (`BsMem`):**
```typescript
async getBlobStream(blobId: string): Promise<ReadableStream> {
  const stored = this.blobs.get(blobId);
  if (!stored) {
    throw new Error(`Blob not found: ${blobId}`);
  }

  // Node.js Readable to Web ReadableStream
  const nodeStream = Readable.from(stored.content);
  return Readable.toWeb(nodeStream) as ReadableStream;
}
```

**Stream to Buffer Conversion:**
```typescript
private async toBuffer(content: ReadableStream): Promise<Buffer> {
  const reader = content.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}
```

### Pagination

**List Blobs with Continuation:**
```typescript
async listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult> {
  let blobs = Array.from(this.blobs.values()).map(s => s.properties);

  // Filter by prefix
  if (options?.prefix) {
    blobs = blobs.filter(b => b.blobId.startsWith(options.prefix!));
  }

  // Sort for consistent ordering
  blobs.sort((a, b) => a.blobId.localeCompare(b.blobId));

  // Pagination
  let startIndex = 0;
  if (options?.continuationToken) {
    startIndex = parseInt(options.continuationToken, 10);
  }

  const maxResults = options?.maxResults || blobs.length;
  const endIndex = startIndex + maxResults;
  const pageBlobs = blobs.slice(startIndex, endIndex);

  const result: ListBlobsResult = { blobs: pageBlobs };

  if (endIndex < blobs.length) {
    result.continuationToken = endIndex.toString();
  }

  return result;
}
```

## Design Patterns

### 1. Strategy Pattern (Storage Backend)

Different implementations of Bs interface:

```typescript
interface Bs {
  setBlob(...): Promise<BlobProperties>;
  getBlob(...): Promise<{ content: Buffer; properties: BlobProperties }>;
  // ...
}

// Strategies:
class BsMem implements Bs { /* In-memory */ }
class BsPeer implements Bs { /* Network */ }
class BsMulti implements Bs { /* Composite */ }
```

**Benefit:** Swap storage strategies without changing client code.

### 2. Composite Pattern (BsMulti)

BsMulti composes multiple Bs instances:

```typescript
class BsMulti implements Bs {
  constructor(private _stores: Array<BsMultiBs>) {}

  async getBlob(blobId: string) {
    for (const store of this._stores) {
      try {
        return await store.bs.getBlob(blobId);  // Delegate
      } catch (e) {
        continue;
      }
    }
    throw new Error('Blob not found');
  }
}
```

**Benefit:** Treat single and composite storage uniformly.

### 3. Proxy Pattern (BsPeer, BsServer)

BsPeer proxies requests to remote Bs:

```typescript
class BsPeer implements Bs {
  async getBlob(blobId: string) {
    // Proxy to remote via socket
    return new Promise((resolve, reject) => {
      this._socket.emit('getBlob', blobId, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }
}
```

**Benefit:** Network transparency - remote storage looks like local.

### 4. Bridge Pattern (BsPeerBridge)

BsPeerBridge bridges socket events to Bs method calls:

```typescript
class BsPeerBridge {
  constructor(private _bs: Bs, private _socket: Socket) {}

  start() {
    this._socket.on('getBlob', (blobId, callback) => {
      this._bs.getBlob(blobId)
        .then(result => callback(null, result))
        .catch(error => callback(error, null));
    });
  }
}
```

**Benefit:** Decouple socket abstraction from Bs implementation.

### 5. Adapter Pattern (Socket Implementations)

Different socket libraries adapted to Socket interface:

```typescript
// SocketMock adapts Map to Socket
class SocketMock implements Socket { /* ... */ }

// SocketIOAdapter adapts Socket.IO to Socket
class SocketIOAdapter implements Socket {
  constructor(private _socket: SocketIOSocket) {}
  // Adapt methods...
}
```

**Benefit:** Use any socket library with Bs components.

## Performance Optimization

### 1. Deduplication

**Space Efficiency:**
- Same content stored only once
- 10 copies of same file = 1 storage cost
- Particularly effective for:
  - Version control (many unchanged files)
  - Backup systems (incremental with dedup)
  - Build artifacts (shared dependencies)

**Example:**
```typescript
// Traditional storage (10 copies = 10x space)
await bs.put('file1', content);
await bs.put('file2', content);  // Same content, different name
// ... 8 more copies

// Content-addressable (10 copies = 1x space)
const { blobId: id1 } = await bs.setBlob(content);
const { blobId: id2 } = await bs.setBlob(content);  // Same blobId
console.log(id1 === id2);  // true - only stored once
```

### 2. Hot-Swapping (Cache Population)

**Automatic Caching:**
```typescript
// First read from remote (slow)
const result = await bsMulti.getBlob(blobId);  // Fetches from network

// Hot-swapped to cache automatically

// Second read from cache (fast)
const result2 = await bsMulti.getBlob(blobId);  // Instant from cache
```

**Benefits:**
- Transparent caching
- No manual cache management
- Reduces network requests
- Improves read latency

### 3. Parallel Operations

**Parallel Writes:**
```typescript
// BsMulti writes to all writables in parallel
await bsMulti.setBlob(content);

// Instead of serial:
// await tier1.setBlob(content);
// await tier2.setBlob(content);
// await tier3.setBlob(content);

// Uses Promise.all for parallelism
```

**Parallel Reads (List):**
```typescript
// Query all stores simultaneously
const results = await Promise.all(
  stores.map(store => store.bs.listBlobs())
);
// Merge results
```

### 4. Stream Support

**Large Blob Handling:**
```typescript
// Avoid loading entire blob into memory
const stream = await bs.getBlobStream(blobId);
const reader = stream.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // Process chunk without buffering entire blob
  processChunk(value);
}
```

**Benefits:**
- Constant memory usage
- Faster time to first byte
- Suitable for large files (GB+)

### 5. Range Requests

**Partial Content Retrieval:**
```typescript
// Download only first 1MB of 100MB blob
const { content } = await bs.getBlob(blobId, {
  range: { start: 0, end: 1024 * 1024 - 1 }
});

// Use for:
// - Previews (first few KB)
// - Resume downloads
// - Random access to large files
```

## Testing Strategy

### Test Pyramid

```
      ┌─────────────┐
      │ Integration │  Full client-server tests
      │   Tests     │  (bs-integration.spec.ts)
      └─────────────┘
     ┌───────────────┐
     │  Component    │   Per-component tests
     │    Tests      │   (bs-mem.spec.ts, etc.)
     └───────────────┘
    ┌─────────────────┐
    │   Unit Tests    │  Internal methods, helpers
    └─────────────────┘
```

### Testing Implementations

**1. BsMem Testing:**
```typescript
it('should deduplicate identical content', async () => {
  const bs = new BsMem();
  const { blobId: id1 } = await bs.setBlob('same');
  const { blobId: id2 } = await bs.setBlob('same');
  expect(id1).toBe(id2);
});
```

**2. BsPeer + BsServer Testing:**
```typescript
it('should handle client-server communication', async () => {
  const storage = new BsMem();
  const server = new BsServer(storage);

  const socket = new SocketMock();
  await server.addSocket(socket);

  const client = new BsPeer(socket);
  await client.init();

  const { blobId } = await client.setBlob('data');
  const { content } = await client.getBlob(blobId);
  expect(content.toString()).toBe('data');
});
```

**3. BsMulti Testing:**
```typescript
it('should hot-swap from remote to cache', async () => {
  const cache = new BsMem();
  const remote = new BsMem();

  // Store in remote only
  const { blobId } = await remote.setBlob('data');

  const multi = new BsMulti([
    { bs: cache, priority: 0, read: true, write: true },
    { bs: remote, priority: 1, read: true, write: false },
  ]);
  await multi.init();

  // First read from remote, hot-swaps to cache
  await multi.getBlob(blobId);

  // Verify cached
  expect(await cache.blobExists(blobId)).toBe(true);
});
```

**4. BsPeerBridge Testing:**
```typescript
it('should only expose read operations', async () => {
  const localStorage = new BsMem();
  const socket = new SocketMock();
  const bridge = new BsPeerBridge(localStorage, socket);
  bridge.start();

  // Verify read operations are registered
  const readOps = ['getBlob', 'blobExists', 'getBlobProperties', 'listBlobs'];
  for (const op of readOps) {
    const listeners = socket._listeners.get(op);
    expect(listeners.length).toBeGreaterThan(0);
  }

  // Verify write operations are NOT registered
  const writeOps = ['setBlob', 'deleteBlob', 'generateSignedUrl'];
  for (const op of writeOps) {
    const listeners = socket._listeners.get(op);
    expect(listeners).toBeUndefined();
  }
});
```

### Conformance Tests

**Golden Tests:**
- Store expected behavior in `test/goldens/`
- Compare actual output against golden files
- Ensures consistent behavior across versions

**Coverage:**
- Target: 100% code coverage
- Tools: Vitest + v8 coverage
- All branches, statements, functions tested

## Conclusion

The `@rljson/bs` architecture provides a flexible, composable, and type-safe blob storage system with:

1. **Content-addressable storage** for automatic deduplication
2. **Modular components** that can be composed into complex hierarchies
3. **Network transparency** via socket abstraction
4. **PULL architecture** for secure client-server interactions
5. **Multi-tier storage** with automatic caching and hot-swapping
6. **Full test coverage** ensuring reliability

The system follows established design patterns (Strategy, Composite, Proxy, Bridge, Adapter) and provides a solid foundation for building distributed storage solutions.

For further details, see:
- [README.public.md](README.public.md) - Usage documentation
- [README.contributors.md](README.contributors.md) - Development guide
- Source code in `src/` directory
- Tests in `test/` directory
