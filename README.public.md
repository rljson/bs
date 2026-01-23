<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/bs

Content-addressable blob storage interface and implementations for rljson.

## Overview

`@rljson/bs` provides a unified interface for blob storage with content-addressable semantics. All blobs are identified by their SHA256 hash, ensuring automatic deduplication and data integrity.

### Key Features

- **Content-Addressable Storage**: Blobs are identified by SHA256 hash of their content
- **Automatic Deduplication**: Identical content is stored only once
- **Multiple Implementations**: In-memory, peer-to-peer, server-based, and multi-tier
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Stream Support**: Efficient handling of large blobs via ReadableStreams
- **100% Test Coverage**: Fully tested with comprehensive test suite

## Installation

```bash
npm install @rljson/bs
```

## Quick Start

### In-Memory Storage

The simplest implementation for testing or temporary storage:

```typescript
import { BsMem } from '@rljson/bs';

// Create an in-memory blob storage
const bs = new BsMem();

// Store a blob - returns SHA256 hash as blobId
const { blobId } = await bs.setBlob('Hello, World!');
console.log(blobId); // e.g., "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"

// Retrieve the blob
const { content } = await bs.getBlob(blobId);
console.log(content.toString()); // "Hello, World!"

// Check if blob exists
const exists = await bs.blobExists(blobId);
console.log(exists); // true

// List all blobs
const { blobs } = await bs.listBlobs();
console.log(blobs.length); // 1
```

### Multi-Tier Storage (Cache + Remote)

Combine multiple storage backends with automatic caching:

```typescript
import { BsMulti, BsMem, BsPeer, PeerSocketMock } from '@rljson/bs';

// Setup remote storage (simulated)
const remoteStore = new BsMem();
const remoteSocket = new PeerSocketMock(remoteStore);
const remotePeer = new BsPeer(remoteSocket);
await remotePeer.init();

// Setup local cache
const localCache = new BsMem();

// Create multi-tier storage with cache-first strategy
const bs = new BsMulti([
  { bs: localCache, priority: 0, read: true, write: true },  // Cache first
  { bs: remotePeer, priority: 1, read: true, write: false }, // Remote fallback
]);
await bs.init();

// Store blob - writes to cache only (writable stores)
const { blobId } = await bs.setBlob('Cached content');

// Read from cache first, falls back to remote
// Automatically hot-swaps remote blobs to cache
const { content } = await bs.getBlob(blobId);
```

## Core Concepts

### Content-Addressable Storage

Every blob is identified by the SHA256 hash of its content. This means:

- **Automatic Deduplication**: Storing the same content twice returns the same `blobId`
- **Data Integrity**: The `blobId` serves as a cryptographic checksum
- **Location Independence**: Blobs can be identified and verified anywhere

```typescript
const bs = new BsMem();

const result1 = await bs.setBlob('Same content');
const result2 = await bs.setBlob('Same content');

// Both return the same blobId
console.log(result1.blobId === result2.blobId); // true
```

### Blob Properties

All blobs have associated metadata:

```typescript
interface BlobProperties {
  blobId: string;      // SHA256 hash of content
  size: number;        // Size in bytes
  contentType: string; // MIME type (default: 'application/octet-stream')
  createdAt: Date;     // Creation timestamp
  metadata?: Record<string, string>; // Optional custom metadata
}
```

## Implementations

### BsMem - In-Memory Storage

Fast, ephemeral storage for testing and temporary data:

```typescript
import { BsMem } from '@rljson/bs';

const bs = new BsMem();
const { blobId } = await bs.setBlob('Temporary data');
```

**Use Cases:**

- Unit testing
- Temporary caching
- Development and prototyping

**Limitations:**

- Data lost when process ends
- Limited by available RAM

### BsPeer - Peer-to-Peer Storage

Access remote blob storage over a socket connection:

```typescript
import { BsPeer, PeerSocketMock } from '@rljson/bs';

// Create a peer connected to a remote storage
const remoteStorage = new BsMem();
const socket = new PeerSocketMock(remoteStorage);
const peer = new BsPeer(socket);
await peer.init();

// Use like any other Bs implementation
const { blobId } = await peer.setBlob('Remote data');
const { content } = await peer.getBlob(blobId);

// Close connection when done
await peer.close();
```

**Use Cases:**

- Distributed systems
- Client-server architectures
- Remote backup

### BsServer - Server-Side Handler

Handle blob storage requests from remote peers:

```typescript
import { BsServer, BsMem, SocketMock } from '@rljson/bs';

// Server-side setup
const storage = new BsMem();
const server = new BsServer(storage);

// Handle incoming connection
const clientSocket = new SocketMock();
const serverSocket = clientSocket.createPeer();
server.handleConnection(serverSocket);

// Client can now access storage through clientSocket
```

**Use Cases:**

- Building blob storage services
- Network protocol implementation
- API backends

### BsMulti - Multi-Tier Storage

Combine multiple storage backends with configurable priorities:

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

- **Priority-Based Reads**: Reads from lowest priority number first
- **Hot-Swapping**: Automatically caches blobs from remote to local
- **Parallel Writes**: Writes to all writable stores simultaneously
- **Deduplication**: Merges results from all readable stores

**Use Cases:**

- Local cache + remote storage
- Local network storage infrastructure
- Backup and archival systems
- Distributed blob storage across network nodes

## API Reference

### Bs Interface

All implementations conform to the `Bs` interface:

#### `setBlob(content: Buffer | string | ReadableStream): Promise<BlobProperties>`

Stores a blob and returns its properties including the SHA256 `blobId`.

```typescript
// From string
const { blobId } = await bs.setBlob('Hello');

// From Buffer
const buffer = Buffer.from('World');
await bs.setBlob(buffer);

// From ReadableStream
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
```

**Note:** In production systems with content-addressable storage, consider implementing reference counting before deletion.

#### `blobExists(blobId: string): Promise<boolean>`

Checks if a blob exists.

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
console.log(`Created: ${props.createdAt}`);
```

#### `listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult>`

Lists all blobs with optional filtering and pagination.

```typescript
// List all blobs
const { blobs } = await bs.listBlobs();

// With prefix filter
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
// Read-only URL valid for 1 hour
const url = await bs.generateSignedUrl(blobId, 3600);

// Delete permission URL
const deleteUrl = await bs.generateSignedUrl(blobId, 300, 'delete');
```

## Advanced Usage

### Custom Storage Implementation

Implement the `Bs` interface to create custom storage backends:

```typescript
import { Bs, BlobProperties } from '@rljson/bs';

class MyCustomStorage implements Bs {
  async setBlob(content: Buffer | string | ReadableStream): Promise<BlobProperties> {
    // Your implementation
  }

  async getBlob(blobId: string) {
    // Your implementation
  }

  // Implement other methods...
}
```

### Multi-Tier Patterns

**Local Cache + Remote Storage:**

```typescript
const bs = new BsMulti([
  { bs: localCache, priority: 0, read: true, write: true },
  { bs: remoteStorage, priority: 1, read: true, write: false },
]);
```

**Write-Through Cache:**

```typescript
const bs = new BsMulti([
  { bs: localCache, priority: 0, read: true, write: true },
  { bs: remoteStorage, priority: 1, read: true, write: true }, // Also writable
]);
```

**Multi-Region Replication:**

```typescript
const bs = new BsMulti([
  { bs: regionUs, priority: 0, read: true, write: true },
  { bs: regionEu, priority: 1, read: true, write: true },
  { bs: regionAsia, priority: 2, read: true, write: true },
]);
```

### Error Handling

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
});
```

## Performance Considerations

### Memory Usage

- `BsMem` stores all data in RAM - suitable for small to medium datasets
- Use streams (`getBlobStream`) for large blobs to avoid loading entire content into memory
- `BsMulti` with local cache reduces network overhead

### Network Efficiency

- Use `BsPeer` for remote access with minimal protocol overhead
- `BsMulti` automatically caches frequently accessed blobs
- Content-addressable nature prevents redundant transfers

### Deduplication

- Identical content stored multiple times occupies space only once
- Particularly effective for:
  - Version control systems
  - Backup solutions
  - Build artifact storage

## License

MIT

## Contributing

Issues and pull requests welcome at <https://github.com/rljson/bs>

## Related Packages

- `@rljson/io` - Data table storage interface and implementations
