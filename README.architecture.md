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
- `getBlob` - Read blob content
- `getBlobStream` - Stream blob content
- `blobExists` - Check existence
- `getBlobProperties` - Get metadata
- `listBlobs` - List available blobs

**NOT Exposed (Write Operations):**
- `setBlob` - Would allow server to write to client
- `deleteBlob` - Would allow server to delete from client
- `generateSignedUrl` - Management operation

**Implementation:**
```typescript
private _registerBsMethods(): void {
  const bsMethods = [
    'getBlob',           // ✅ READ
    'getBlobStream',     // ✅ READ
    'blobExists',        // ✅ READ
    'getBlobProperties', // ✅ READ
    'listBlobs',         // ✅ READ
    // NOT: 'setBlob', 'deleteBlob', 'generateSignedUrl'
  ];

  for (const methodName of bsMethods) {
    this.registerEvent(methodName);
  }
}
```

**Callback Pattern (Error-First):**
```typescript
const handler = (...args: any[]) => {
  const callback = args[args.length - 1];
  const methodArgs = args.slice(0, -1);

  bsMethod.apply(this._bs, methodArgs)
    .then((result) => {
      callback(null, result);  // ✅ Error-first: (error, result)
    })
    .catch((error) => {
      callback(error, null);   // ✅ Error-first: (error, result)
    });
};
```

**Why Read-Only?**

1. **Security**: Prevents server from pushing malicious data to clients
2. **Architectural Clarity**: Clear unidirectional data flow (PULL)
3. **Consistency with IoPeerBridge**: Matches the pattern from `@rljson/io`
4. **Client Control**: Client owns its local storage, server can only read

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

**Read Strategy:**
1. Sort stores by priority (ascending)
2. Try each readable store in order
3. First successful read wins
4. Hot-swap: Write to all writable stores for caching
5. Return result

**Write Strategy:**
1. Collect all writable stores
2. Write to all in parallel using `Promise.all`
3. All writes must succeed (or error)
4. Content-addressable ensures consistency

**Hot-Swapping:**
```typescript
async getBlob(blobId: string): Promise<{ content: Buffer; properties: BlobProperties }> {
  // Try stores in priority order
  for (const readable of this.readables) {
    try {
      result = await readable.bs.getBlob(blobId);
      readFrom = readable.id;
      break;
    } catch (e) {
      continue;
    }
  }

  // Hot-swap: Cache in all writables (except source)
  const hotSwapWrites = this.writables
    .filter((writable) => writable.id !== readFrom)
    .map(({ bs }) => bs.setBlob(result.content).catch(() => {}));

  await Promise.all(hotSwapWrites);
  return result;
}
```

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

Content addressing uses SHA256 to generate a unique identifier for each blob.

**Hash Calculation:**
```typescript
import { createHash } from 'crypto';

function calculateBlobId(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
```

**Properties:**
- **Deterministic**: Same content always produces same hash
- **Collision-Resistant**: Practically impossible to find two different contents with same hash
- **Fixed Length**: Always 64 hexadecimal characters (256 bits)
- **One-Way**: Cannot derive content from hash

### Deduplication Mechanics

**Automatic Deduplication:**
```typescript
async setBlob(content: Buffer | string | ReadableStream): Promise<BlobProperties> {
  const buffer = await this.toBuffer(content);
  const blobId = hshBuffer(buffer);

  // Check if blob already exists
  const existing = this.blobs.get(blobId);
  if (existing) {
    return existing.properties;  // Return existing, don't store again
  }

  // Store new blob
  const properties: BlobProperties = {
    blobId,
    size: buffer.length,
    createdAt: new Date(),
  };

  this.blobs.set(blobId, { content: buffer, properties });
  return properties;
}
```

**Benefits in Multi-Tier:**
```typescript
// Same content stored in multiple tiers = same blobId
// BsMulti writes to all writables, but no duplicate storage cost
// because content-addressable storage deduplicates automatically

await bsMulti.setBlob('same content');  // Writes to tier1, tier2
await bsMulti.setBlob('same content');  // No-op (already exists)
```

### Content Verification

Any party can verify content integrity:

```typescript
async verifyBlob(blobId: string, content: Buffer): boolean {
  const computedId = calculateBlobId(content);
  return computedId === blobId;
}
```

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

**Message Format (Socket Events):**
```
Event: <methodName>
Args: [...methodArgs, callback]

Example:
socket.emit('getBlob', blobId, options, (error, result) => {
  if (error) console.error(error);
  else console.log(result);
});
```

**Error-First Callbacks:**
```typescript
callback(error: Error | null, result?: T);

// Success
callback(null, { content: buffer, properties: props });

// Error
callback(new Error('Blob not found'), null);
```

### Client-Server Flow

**Complete Request/Response Cycle:**
```
1. Client: BsPeer.getBlob(blobId)
   ├─> Create promise
   └─> socket.emit('getBlob', blobId, callback)

2. Network: Transport socket event

3. Server: BsServer receives 'getBlob' event
   ├─> Extract args and callback
   ├─> Call underlying bs.getBlob(blobId)
   ├─> Wait for result
   └─> Invoke callback(null, result)

4. Network: Transport callback response

5. Client: BsPeer callback invoked
   ├─> Resolve or reject promise
   └─> Return to caller
```

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
- getBlobStream     // ✅ READ
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

### Read Path with Hot-Swapping

```
1. Request: getBlob(blobId)

2. Check Priority 0 (cache)
   ├─ HIT: Return immediately ✅
   └─ MISS: Continue to Priority 1

3. Check Priority 1 (network)
   ├─ HIT:
   │  ├─ Return content
   │  └─ Hot-swap to Priority 0 (cache for next time)
   └─ MISS: Continue to Priority 2

4. Check Priority 2 (backup)
   ├─ HIT:
   │  ├─ Return content
   │  └─ Hot-swap to Priority 0 and 1
   └─ MISS: Throw "Blob not found"
```

**Code:**
```typescript
async getBlob(blobId: string): Promise<{ content: Buffer; properties: BlobProperties }> {
  for (const readable of this.readables) {
    try {
      result = await readable.bs.getBlob(blobId);
      readFrom = readable.id;
      break;
    } catch (e) {
      continue;  // Try next priority
    }
  }

  if (!result) {
    throw new Error(`Blob not found: ${blobId}`);
  }

  // Hot-swap to all writables (except source)
  const hotSwapWrites = this.writables
    .filter((writable) => writable.id !== readFrom)
    .map(({ bs }) => bs.setBlob(result.content).catch(() => {}));

  await Promise.all(hotSwapWrites);
  return result;
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
- `Method not found`: BsPeerBridge received unknown method
- Network errors: Socket connection failures

### Stream Handling

**Buffer to Stream Conversion:**
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
  const readOps = ['getBlob', 'blobExists', 'getBlobProperties', 'listBlobs', 'getBlobStream'];
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
