<!--
@license
Copyright (c) 2026 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/bs

Content-addressable blob storage interface and implementations for TypeScript/JavaScript.

## Overview

`@rljson/bs` provides a unified interface for blob storage with content-addressable semantics. All blobs are identified by their SHA256 hash, ensuring automatic deduplication, data integrity verification, and location independence.

### Key Features

- **Content-Addressable Storage**: Blobs are identified by SHA256 hash of their content
- **Automatic Deduplication**: Identical content is stored only once across the entire system
- **Multiple Implementations**: In-memory, peer-to-peer, server-based, and multi-tier
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Stream Support**: Efficient handling of large blobs via ReadableStreams
- **Network Layer**: Built-in peer-to-peer and client-server implementations
- **100% Test Coverage**: Fully tested with comprehensive test suite

## Installation

```bash
npm install @rljson/bs
```

## Quick Start

### Basic Usage: In-Memory Storage

The simplest implementation for testing or temporary storage:

```typescript
import { BsMem } from '@rljson/bs';

// Create an in-memory blob storage
const bs = new BsMem();

// Store a blob - returns SHA256 hash as blobId
const { blobId, size } = await bs.setBlob('Hello, World!');
console.log(blobId); // "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"
console.log(size);   // 13

// Retrieve the blob
const { content } = await bs.getBlob(blobId);
console.log(content.toString()); // "Hello, World!"

// Check if blob exists
const exists = await bs.blobExists(blobId);
console.log(exists); // true

// Get blob properties without downloading
const props = await bs.getBlobProperties(blobId);
console.log(props.createdAt); // Timestamp

// List all blobs
const { blobs } = await bs.listBlobs();
console.log(blobs.length); // 1
```

### Client-Server Architecture

Access remote blob storage over a socket connection:

```typescript
import { BsMem, BsServer, BsPeer, SocketMock } from '@rljson/bs';

// Server setup
const storage = new BsMem();
const server = new BsServer(storage);

// Client setup
const socket = new SocketMock(); // Use real socket in production
await server.addSocket(socket);
const client = new BsPeer(socket);
await client.init();

// Client can now access server storage
const { blobId } = await client.setBlob('Remote data');
const { content } = await client.getBlob(blobId);
console.log(content.toString()); // "Remote data"

// Close connection
await client.close();
```

### Multi-Tier Storage (Cache + Remote)

Combine multiple storage backends with automatic caching:

```typescript
import { BsMulti, BsMem, BsPeer } from '@rljson/bs';

// Setup local cache
const localCache = new BsMem();

// Setup remote storage (via BsPeer)
const remotePeer = new BsPeer(remoteSocket);
await remotePeer.init();

// Create multi-tier storage with cache-first strategy
const bs = new BsMulti([
  { bs: localCache, priority: 0, read: true, write: true },  // Cache first
  { bs: remotePeer, priority: 1, read: true, write: false }, // Remote fallback
]);
await bs.init();

// Store blob - writes to cache only (writable stores)
const { blobId } = await bs.setBlob('Cached content');

// Read from cache first, falls back to remote if not found
// Automatically hot-swaps remote blobs to cache for future reads
const { content } = await bs.getBlob(blobId);
```

## Core Concepts

### Content-Addressable Storage

Every blob is identified by the SHA256 hash of its content:

```typescript
const bs = new BsMem();

const result1 = await bs.setBlob('Same content');
const result2 = await bs.setBlob('Same content');

// Both return the same blobId (automatic deduplication)
console.log(result1.blobId === result2.blobId); // true

// Different content = different blobId
const result3 = await bs.setBlob('Different content');
console.log(result1.blobId !== result3.blobId); // true
```

**Benefits:**

- **Automatic Deduplication**: Identical content stored once, regardless of how many times you call `setBlob`
- **Data Integrity**: The `blobId` serves as a cryptographic checksum
- **Location Independence**: Blobs can be identified and verified anywhere
- **Cache Efficiency**: Content can be cached anywhere and verified by its hash

### Blob Properties

All blobs have associated metadata:

```typescript
interface BlobProperties {
  blobId: string;      // SHA256 hash of content (64 hex characters)
  size: number;        // Size in bytes
  createdAt: Date;     // Creation timestamp
}
```

## API Reference

### Bs Interface

All implementations conform to the `Bs` interface:

#### `setBlob(content: Buffer | string | ReadableStream): Promise<BlobProperties>`

Stores a blob and returns its properties including the SHA256 `blobId`.

```typescript
// From string
const { blobId } = await bs.setBlob('Hello');

// From Buffer
const buffer = Buffer.from('World', 'utf8');
await bs.setBlob(buffer);

// From ReadableStream (for large files)
const stream = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('Stream data'));
    controller.close();
  }
});
await bs.setBlob(stream);
```

#### `getBlob(blobId: string, options?: DownloadBlobOptions): Promise<{ content: Buffer; properties: BlobProperties }>`

Retrieves a blob by its ID.

```typescript
const { content, properties } = await bs.getBlob(blobId);
console.log(content.toString());
console.log(properties.size);

// With range request (partial content)
const { content: partial } = await bs.getBlob(blobId, {
  range: { start: 0, end: 99 } // First 100 bytes
});
```

#### `getBlobStream(blobId: string): Promise<ReadableStream<Uint8Array>>`

Retrieves a blob as a stream for efficient handling of large files.

```typescript
const stream = await bs.getBlobStream(blobId);
const reader = stream.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  // Process chunk
  console.log('Chunk size:', value.length);
}
```

#### `deleteBlob(blobId: string): Promise<void>`

Deletes a blob from storage.

```typescript
await bs.deleteBlob(blobId);

// Note: In production with content-addressable storage,
// consider reference counting before deletion
```

#### `blobExists(blobId: string): Promise<boolean>`

Checks if a blob exists without downloading it.

```typescript
if (await bs.blobExists(blobId)) {
  console.log('Blob found');
}
```

#### `getBlobProperties(blobId: string): Promise<BlobProperties>`

Gets blob metadata without downloading content.

```typescript
const props = await bs.getBlobProperties(blobId);
console.log(`Blob size: ${props.size} bytes`);
console.log(`Created: ${props.createdAt.toISOString()}`);
```

#### `listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult>`

Lists all blobs with optional filtering and pagination.

```typescript
// List all blobs
const { blobs } = await bs.listBlobs();

// With prefix filter (blobs starting with "abc")
const result = await bs.listBlobs({ prefix: 'abc' });

// Paginated listing
let continuationToken: string | undefined;
do {
  const result = await bs.listBlobs({
    maxResults: 100,
    continuationToken
  });

  console.log(`Got ${result.blobs.length} blobs`);
  continuationToken = result.continuationToken;
} while (continuationToken);
```

#### `generateSignedUrl(blobId: string, expiresIn: number, permissions?: 'read' | 'delete'): Promise<string>`

Generates a signed URL for temporary access to a blob.

```typescript
// Read-only URL valid for 1 hour (3600 seconds)
const url = await bs.generateSignedUrl(blobId, 3600);

// Delete permission URL valid for 5 minutes
const deleteUrl = await bs.generateSignedUrl(blobId, 300, 'delete');
```

## Implementations

### BsMem - In-Memory Storage

Fast, ephemeral storage for testing and temporary data.

```typescript
import { BsMem } from '@rljson/bs';

const bs = new BsMem();
const { blobId } = await bs.setBlob('Temporary data');
```

**Use Cases:**

- Unit testing
- Temporary caching
- Development and prototyping
- Fast local storage for small datasets

**Limitations:**

- Data lost when process ends
- Limited by available RAM
- Single-process only

### BsPeer - Peer-to-Peer Storage Client

Access remote blob storage over a socket connection.

```typescript
import { BsPeer } from '@rljson/bs';

// Create a peer connected to a remote storage
const peer = new BsPeer(socket);
await peer.init();

// Use like any other Bs implementation
const { blobId } = await peer.setBlob('Remote data');
const { content } = await peer.getBlob(blobId);

// Close connection when done
await peer.close();
```

**Use Cases:**

- Client-server architectures
- Distributed systems
- Remote backup
- Accessing centralized storage

**Features:**

- Async socket-based communication
- Error-first callback pattern (Node.js style)
- Connection state management
- Automatic retry support

### BsServer - Server-Side Handler

Handle blob storage requests from remote peers.

```typescript
import { BsServer, BsMem, SocketMock } from '@rljson/bs';

// Server-side setup
const storage = new BsMem();
const server = new BsServer(storage);

// Handle incoming connection
const clientSocket = new SocketMock(); // Use real socket in production
await server.addSocket(clientSocket);

// Client can now access storage through socket
```

**Use Cases:**

- Building blob storage services
- Network protocol implementation
- API backends
- Multi-client storage systems

**Features:**

- Multiple client support
- Socket lifecycle management
- Automatic method mapping
- Error handling

### BsPeerBridge - PULL Architecture Bridge (Read-Only)

Exposes local blob storage for server to PULL from (read-only access).

```typescript
import { BsPeerBridge, BsMem } from '@rljson/bs';

// Client-side: expose local storage for server to read
const localStorage = new BsMem();
const bridge = new BsPeerBridge(localStorage, socket);
bridge.start();

// Server can now read from client's local storage
// but CANNOT write to it (PULL architecture)
```

**Architecture Pattern:**

- **PULL-only**: Server can read from client, but cannot write
- **Read Operations Only**: `getBlob`, `getBlobStream`, `blobExists`, `getBlobProperties`, `listBlobs`
- **No Write Operations**: Does not expose `setBlob`, `deleteBlob`, or `generateSignedUrl`

**Use Cases:**

- Client exposes local cache for server to access
- Distributed storage where server pulls from clients
- Peer-to-peer networks with read-only sharing

### BsMulti - Multi-Tier Storage

Combine multiple storage backends with configurable priorities.

```typescript
import { BsMulti, BsMem } from '@rljson/bs';

const fastCache = new BsMem();
const mainStorage = new BsMem();
const backup = new BsMem();

const bs = new BsMulti([
  { bs: fastCache, priority: 0, read: true, write: true },   // L1 cache
  { bs: mainStorage, priority: 1, read: true, write: true }, // Main storage
  { bs: backup, priority: 2, read: true, write: false },     // Read-only backup
]);
await bs.init();
```

**Features:**

- **Priority-Based Reads**: Reads from lowest priority number first (0 = highest priority)
- **Hot-Swapping**: Automatically caches blobs from remote to local on read
- **Parallel Writes**: Writes to all writable stores simultaneously
- **Deduplication**: Merges results from all readable stores when listing
- **Graceful Fallback**: If highest priority fails, falls back to next priority

**Use Cases:**

- Local cache + remote storage
- Multi-region storage replication
- Local network storage infrastructure
- Backup and archival systems
- Hierarchical storage management (HSM)

## Common Patterns

### Local Cache + Remote Storage (PULL Architecture)

```typescript
const localCache = new BsMem();
const remotePeer = new BsPeer(remoteSocket);
await remotePeer.init();

const bs = new BsMulti([
  { bs: localCache, priority: 0, read: true, write: true },
  { bs: remotePeer, priority: 1, read: true, write: false }, // Read-only
]);

// Writes go to cache only
await bs.setBlob('data');

// Reads check cache first, then remote
// Remote blobs are automatically cached
const { content } = await bs.getBlob(blobId);
```

### Write-Through Cache

```typescript
const bs = new BsMulti([
  { bs: localCache, priority: 0, read: true, write: true },
  { bs: remoteStorage, priority: 1, read: true, write: true }, // Also writable
]);

// Writes go to both cache and remote simultaneously
await bs.setBlob('data');
```

### Multi-Region Replication

```typescript
const bs = new BsMulti([
  { bs: regionUs, priority: 0, read: true, write: true },
  { bs: regionEu, priority: 1, read: true, write: true },
  { bs: regionAsia, priority: 2, read: true, write: true },
]);

// Writes replicate to all regions
// Reads come from fastest responding region
```

### Client-Server with BsPeerBridge (PULL Pattern)

```typescript
// Client setup
const clientStorage = new BsMem();
const bridge = new BsPeerBridge(clientStorage, socketToServer);
bridge.start(); // Exposes read-only access to server

const bsPeer = new BsPeer(socketToServer);
await bsPeer.init();

const clientBs = new BsMulti([
  { bs: clientStorage, priority: 0, read: true, write: true }, // Local storage
  { bs: bsPeer, priority: 1, read: true, write: false },       // Server (read-only)
]);

// Server can pull from client via bridge
// Client can pull from server via bsPeer
```

## Error Handling

All methods throw errors for invalid operations:

```typescript
try {
  await bs.getBlob('nonexistent-id');
} catch (error) {
  console.error('Blob not found:', error.message);
}

// BsMulti gracefully handles partial failures
const multi = new BsMulti([
  { bs: failingStore, priority: 0, read: true, write: false },
  { bs: workingStore, priority: 1, read: true, write: false },
]);

// Falls back to workingStore if failingStore errors
const { content } = await multi.getBlob(blobId);
```

## Testing

The package includes comprehensive test utilities:

```typescript
import { BsMem } from '@rljson/bs';
import { describe, it, expect, beforeEach } from 'vitest';

describe('My Tests', () => {
  let bs: BsMem;

  beforeEach(() => {
    bs = new BsMem();
  });

  it('should store and retrieve blobs', async () => {
    const { blobId } = await bs.setBlob('test data');
    const { content } = await bs.getBlob(blobId);
    expect(content.toString()).toBe('test data');
  });

  it('should deduplicate identical content', async () => {
    const result1 = await bs.setBlob('same');
    const result2 = await bs.setBlob('same');
    expect(result1.blobId).toBe(result2.blobId);
  });
});
```

## Performance Considerations

### Memory Usage

- `BsMem` stores all data in RAM - suitable for small to medium datasets
- Use streams (`getBlobStream`) for large blobs to avoid loading entire content into memory
- `BsMulti` with local cache reduces network overhead significantly

### Network Efficiency

- Use `BsPeer` for remote access with minimal protocol overhead
- `BsMulti` automatically caches frequently accessed blobs locally
- Content-addressable nature prevents redundant transfers (same content = same hash)
- Hot-swapping in `BsMulti` reduces repeated network requests

### Deduplication Benefits

- Identical content stored multiple times occupies space only once
- Particularly effective for:
  - Version control systems (many files unchanged between versions)
  - Backup solutions (incremental backups with deduplication)
  - Build artifact storage (shared dependencies)
  - Document management (attachments, templates)

## Migration Guide

### From Traditional Blob Storage

Traditional blob storage typically uses arbitrary identifiers:

```typescript
// Traditional
await blobStore.put('my-file-id', content);
const data = await blobStore.get('my-file-id');
```

With content-addressable storage, the ID is derived from content:

```typescript
// Content-addressable
const { blobId } = await bs.setBlob(content); // blobId = SHA256(content)
const { content } = await bs.getBlob(blobId);
```

**Key Differences:**

1. **No custom IDs**: You cannot choose blob IDs, they are computed
2. **Automatic deduplication**: Same content = same ID
3. **Verify on read**: You can verify content integrity by recomputing the hash
4. **External metadata**: Store file names, tags, etc. separately (e.g., in @rljson/io)

## Frequently Asked Questions

### Q: How do I organize blobs into folders or containers?

A: The Bs interface provides a flat storage pool. Organizational metadata (folders, tags, file names) should be stored separately, such as in a database or using `@rljson/io` (data table storage). Reference blobs by their `blobId`.

### Q: What happens if I delete a blob that's referenced elsewhere?

A: The blob is permanently deleted. In production systems with shared blobs, implement reference counting before deletion.

### Q: Can I use this in the browser?

A: Yes, but you'll need to provide your own Socket implementation for network communication, or use `BsMem` for local-only storage.

### Q: How does BsMulti handle write conflicts?

A: `BsMulti` writes to all writable stores in parallel. If any write fails, the error is thrown. All writable stores will have the blob since content is identical (content-addressable).

### Q: Why is BsPeerBridge read-only?

A: BsPeerBridge implements the PULL architecture pattern, where the server can read from client storage but cannot modify it. This prevents the server from pushing unwanted data to clients. Use BsPeer for client-to-server writes.

## License

MIT

## Contributing

Issues and pull requests welcome at <https://github.com/rljson/bs>

## Related Packages

- `@rljson/io` - Data table storage interface and implementations
- `@rljson/hash` - Cryptographic hashing utilities
