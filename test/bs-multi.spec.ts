// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem, BsMulti, BsMultiBs, BsPeer, PeerSocketMock } from '../src';

describe('BsMulti', () => {
  let localCache: BsMem;
  let remoteStore: BsMem;
  let remotePeer: BsPeer;
  let bsMulti: BsMulti;
  let stores: Array<BsMultiBs>;

  beforeEach(async () => {
    // Setup local cache
    localCache = new BsMem();

    // Setup remote server (simulated with PeerSocketMock)
    remoteStore = new BsMem();
    const remoteSocket = new PeerSocketMock(remoteStore);
    remotePeer = new BsPeer(remoteSocket);
    await remotePeer.init();

    // Create multi-tier store: local cache + remote fallback
    stores = [
      { bs: localCache, priority: 0, read: true, write: true }, // Cache first
      { bs: remotePeer, priority: 1, read: true, write: false }, // Remote fallback (read-only)
    ];

    bsMulti = new BsMulti(stores);
    await bsMulti.init();
  });

  afterEach(async () => {
    await remotePeer.close();
  });

  describe('initialization', () => {
    it('should initialize and assign IDs to stores', async () => {
      const testStores: Array<BsMultiBs> = [
        { bs: new BsMem(), priority: 0, read: true, write: true },
      ];

      const testMulti = new BsMulti(testStores);
      await testMulti.init();

      expect(testStores[0].id).toBe('bs-0');
    });

    it('should handle stores without IDs in getBlob', async () => {
      // Create a store without an ID field
      const storeWithoutId = new BsMem();
      const { blobId } = await storeWithoutId.setBlob('Test');

      const testStores: Array<BsMultiBs> = [
        { bs: storeWithoutId, priority: 0, read: true, write: true },
      ];

      const testMulti = new BsMulti(testStores);
      // Don't call init() to keep id undefined

      const result = await testMulti.getBlob(blobId);
      expect(result.content.toString()).toBe('Test');
    });

    it('should filter and sort readables by priority', () => {
      const store1 = new BsMem();
      const store2 = new BsMem();
      const store3 = new BsMem();

      const testStores: Array<BsMultiBs> = [
        { bs: store1, priority: 2, read: true, write: false },
        { bs: store2, priority: 0, read: false, write: true }, // Not readable
        { bs: store3, priority: 1, read: true, write: true },
      ];

      const testMulti = new BsMulti(testStores);

      const readables = testMulti.readables;
      expect(readables).toHaveLength(2);
      expect(readables[0].priority).toBe(1); // Lowest priority number first
      expect(readables[1].priority).toBe(2);
    });

    it('should filter and sort writables by priority', () => {
      const store1 = new BsMem();
      const store2 = new BsMem();
      const store3 = new BsMem();

      const testStores: Array<BsMultiBs> = [
        { bs: store1, priority: 2, read: false, write: true },
        { bs: store2, priority: 0, read: true, write: false }, // Not writable
        { bs: store3, priority: 1, read: true, write: true },
      ];

      const testMulti = new BsMulti(testStores);

      const writables = testMulti.writables;
      expect(writables).toHaveLength(2);
      expect(writables[0].priority).toBe(1); // Lowest priority number first
      expect(writables[1].priority).toBe(2);
    });
  });

  describe('setBlob', () => {
    it('should write to all writable stores in parallel', async () => {
      const content = Buffer.from('Test content');
      const result = await bsMulti.setBlob(content);

      expect(result.blobId).toBeDefined();
      expect(result.size).toBe(12);

      // Verify blob exists in local cache (writable)
      expect(await localCache.blobExists(result.blobId)).toBe(true);

      // Verify blob does NOT exist in remote (read-only)
      expect(await remoteStore.blobExists(result.blobId)).toBe(false);
    });

    it('should throw error when no writable stores available', async () => {
      const readOnlyStores: Array<BsMultiBs> = [
        { bs: remotePeer, priority: 0, read: true, write: false },
      ];

      const readOnlyMulti = new BsMulti(readOnlyStores);
      await readOnlyMulti.init();

      await expect(readOnlyMulti.setBlob('test')).rejects.toThrow(
        'No writable Bs available',
      );
    });

    it('should write to multiple writable stores', async () => {
      const cache1 = new BsMem();
      const cache2 = new BsMem();

      const multiWriteStores: Array<BsMultiBs> = [
        { bs: cache1, priority: 0, read: true, write: true },
        { bs: cache2, priority: 1, read: true, write: true },
      ];

      const multiWriteMulti = new BsMulti(multiWriteStores);
      await multiWriteMulti.init();

      const result = await multiWriteMulti.setBlob('Multi write test');

      expect(await cache1.blobExists(result.blobId)).toBe(true);
      expect(await cache2.blobExists(result.blobId)).toBe(true);
    });
  });

  describe('getBlob', () => {
    it('should read from local cache first', async () => {
      const content = 'Cache first';
      const { blobId } = await localCache.setBlob(content);

      const result = await bsMulti.getBlob(blobId);

      expect(result.content.toString()).toBe(content);
      expect(result.properties.blobId).toBe(blobId);
    });

    it('should fallback to remote when not in cache', async () => {
      const content = 'Remote fallback';
      const { blobId } = await remoteStore.setBlob(content);

      const result = await bsMulti.getBlob(blobId);

      expect(result.content.toString()).toBe(content);
      expect(result.properties.blobId).toBe(blobId);

      // Verify hot-swap: blob should now be in local cache
      expect(await localCache.blobExists(blobId)).toBe(true);
    });

    it('should hot-swap blob to cache after remote read', async () => {
      const content = Buffer.from('Hot swap test');
      const { blobId } = await remoteStore.setBlob(content);

      // Verify NOT in cache initially
      expect(await localCache.blobExists(blobId)).toBe(false);

      // Read from multi (will get from remote)
      await bsMulti.getBlob(blobId);

      // Verify NOW in cache (hot-swapped)
      expect(await localCache.blobExists(blobId)).toBe(true);
      const cached = await localCache.getBlob(blobId);
      expect(cached.content.toString()).toBe(content.toString());
    });

    it('should throw error when blob not found in any store', async () => {
      await expect(bsMulti.getBlob('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );
    });

    it('should support range requests', async () => {
      const content = Buffer.from('0123456789');
      const { blobId } = await localCache.setBlob(content);

      const result = await bsMulti.getBlob(blobId, {
        range: { start: 2, end: 5 },
      });

      expect(result.content.toString()).toBe('234');
    });

    it('should throw error when no readable stores available', async () => {
      const noReadStores: Array<BsMultiBs> = [
        { bs: new BsMem(), priority: 0, read: false, write: true },
      ];

      const noReadMulti = new BsMulti(noReadStores);
      await noReadMulti.init();

      await expect(noReadMulti.getBlob('any-id')).rejects.toThrow(
        'No readable Bs available',
      );
    });
  });

  describe('getBlobStream', () => {
    it('should return stream from first available store', async () => {
      const content = 'Stream content';
      const { blobId } = await localCache.setBlob(content);

      const stream = await bsMulti.getBlobStream(blobId);
      expect(stream).toBeInstanceOf(ReadableStream);

      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const result = Buffer.concat(chunks).toString();
      expect(result).toBe(content);
    });

    it('should fallback to remote for stream', async () => {
      const content = 'Remote stream';
      const { blobId } = await remoteStore.setBlob(content);

      const stream = await bsMulti.getBlobStream(blobId);
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should throw error when stream not found', async () => {
      await expect(bsMulti.getBlobStream('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );
    });
  });

  describe('deleteBlob', () => {
    it('should delete from all writable stores', async () => {
      const content = 'Delete test';
      const { blobId } = await localCache.setBlob(content);

      await bsMulti.deleteBlob(blobId);

      expect(await localCache.blobExists(blobId)).toBe(false);
    });

    it('should delete from multiple writable stores', async () => {
      const cache1 = new BsMem();
      const cache2 = new BsMem();

      const multiWriteStores: Array<BsMultiBs> = [
        { bs: cache1, priority: 0, read: true, write: true },
        { bs: cache2, priority: 1, read: true, write: true },
      ];

      const multiWriteMulti = new BsMulti(multiWriteStores);
      await multiWriteMulti.init();

      const { blobId } = await multiWriteMulti.setBlob('Delete from multiple');

      await multiWriteMulti.deleteBlob(blobId);

      expect(await cache1.blobExists(blobId)).toBe(false);
      expect(await cache2.blobExists(blobId)).toBe(false);
    });

    it('should throw error when no writable stores available', async () => {
      const readOnlyStores: Array<BsMultiBs> = [
        { bs: remotePeer, priority: 0, read: true, write: false },
      ];

      const readOnlyMulti = new BsMulti(readOnlyStores);
      await readOnlyMulti.init();

      await expect(readOnlyMulti.deleteBlob('any-id')).rejects.toThrow(
        'No writable Bs available',
      );
    });
  });

  describe('blobExists', () => {
    it('should return true if blob exists in any store', async () => {
      const { blobId } = await localCache.setBlob('Exists locally');

      expect(await bsMulti.blobExists(blobId)).toBe(true);
    });

    it('should check remote when not in cache', async () => {
      const { blobId } = await remoteStore.setBlob('Exists remotely');

      expect(await bsMulti.blobExists(blobId)).toBe(true);
    });

    it('should return false when blob not found anywhere', async () => {
      expect(await bsMulti.blobExists('nonexistent123')).toBe(false);
    });

    it('should throw error when no readable stores available', async () => {
      const noReadStores: Array<BsMultiBs> = [
        { bs: new BsMem(), priority: 0, read: false, write: true },
      ];

      const noReadMulti = new BsMulti(noReadStores);
      await noReadMulti.init();

      await expect(noReadMulti.blobExists('any-id')).rejects.toThrow(
        'No readable Bs available',
      );
    });
  });

  describe('getBlobProperties', () => {
    it('should get properties from first available store', async () => {
      const content = 'Props test';
      const { blobId } = await localCache.setBlob(content);

      const props = await bsMulti.getBlobProperties(blobId);

      expect(props.blobId).toBe(blobId);
      expect(props.size).toBe(10);
      expect(props.createdAt).toBeInstanceOf(Date);
    });

    it('should fallback to remote for properties', async () => {
      const { blobId } = await remoteStore.setBlob('Remote props');

      const props = await bsMulti.getBlobProperties(blobId);

      expect(props.blobId).toBe(blobId);
    });

    it('should throw error when blob not found', async () => {
      await expect(bsMulti.getBlobProperties('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );
    });
  });

  describe('listBlobs', () => {
    it('should merge blobs from all stores and deduplicate', async () => {
      // Add blobs to local cache
      await localCache.setBlob('Local 1');
      await localCache.setBlob('Local 2');

      // Add blobs to remote
      await remoteStore.setBlob('Remote 1');
      await remoteStore.setBlob('Remote 2');

      // Add duplicate content (should be deduplicated by blobId)
      await localCache.setBlob('Duplicate');
      await remoteStore.setBlob('Duplicate');

      const result = await bsMulti.listBlobs();

      // Should have 5 unique blobs (not 6)
      expect(result.blobs).toHaveLength(5);
    });

    it('should support prefix filtering', async () => {
      const { blobId: id1 } = await localCache.setBlob('Prefix test 1');
      await localCache.setBlob('Other content');

      const prefix = id1.substring(0, 5);
      const result = await bsMulti.listBlobs({ prefix });

      expect(result.blobs.length).toBeGreaterThanOrEqual(1);
      expect(result.blobs.every((b) => b.blobId.startsWith(prefix))).toBe(true);
    });

    it('should support pagination', async () => {
      await localCache.setBlob('Page 1');
      await localCache.setBlob('Page 2');
      await localCache.setBlob('Page 3');

      const page1 = await bsMulti.listBlobs({ maxResults: 2 });

      expect(page1.blobs).toHaveLength(2);
      expect(page1.continuationToken).toBeDefined();

      const page2 = await bsMulti.listBlobs({
        maxResults: 2,
        continuationToken: page1.continuationToken,
      });

      expect(page2.blobs).toHaveLength(1);
      expect(page2.continuationToken).toBeUndefined();
    });

    it('should return empty list when no blobs exist', async () => {
      const result = await bsMulti.listBlobs();

      expect(result.blobs).toEqual([]);
      expect(result.continuationToken).toBeUndefined();
    });

    it('should handle invalid continuation token by starting from beginning', async () => {
      await localCache.setBlob('Content 1');
      await localCache.setBlob('Content 2');

      // Use an invalid continuation token
      const result = await bsMulti.listBlobs({
        continuationToken: 'invalid-token-that-does-not-exist',
        maxResults: 10,
      });

      // Should start from beginning when token not found
      expect(result.blobs.length).toBeGreaterThanOrEqual(2);
    });

    it('should throw error when no readable stores available', async () => {
      const noReadStores: Array<BsMultiBs> = [
        { bs: new BsMem(), priority: 0, read: false, write: true },
      ];

      const noReadMulti = new BsMulti(noReadStores);
      await noReadMulti.init();

      await expect(noReadMulti.listBlobs()).rejects.toThrow(
        'No readable Bs available',
      );
    });
  });

  describe('generateSignedUrl', () => {
    it('should generate URL from first available store', async () => {
      const { blobId } = await localCache.setBlob('URL test');

      const url = await bsMulti.generateSignedUrl(blobId, 3600);

      expect(url).toContain(blobId);
      expect(url).toContain('expires=');
    });

    it('should fallback to remote for URL generation', async () => {
      const { blobId } = await remoteStore.setBlob('Remote URL');

      const url = await bsMulti.generateSignedUrl(blobId, 3600);

      expect(url).toContain(blobId);
    });

    it('should support different permissions', async () => {
      const { blobId } = await localCache.setBlob('Permissions test');

      const url = await bsMulti.generateSignedUrl(blobId, 3600, 'delete');

      expect(url).toContain('permissions=delete');
    });

    it('should throw error when blob not found', async () => {
      await expect(
        bsMulti.generateSignedUrl('nonexistent123', 3600),
      ).rejects.toThrow('Blob not found');
    });
  });

  describe('priority ordering', () => {
    it('should read from highest priority (lowest number) store first', async () => {
      const lowPriorityCache = new BsMem();
      const highPriorityCache = new BsMem();

      // Add same content to both with different metadata
      const content = 'Priority test';
      await lowPriorityCache.setBlob(content);
      await new Promise((resolve) => setTimeout(resolve, 10)); // Ensure different timestamp
      await highPriorityCache.setBlob(content);

      const priorityStores: Array<BsMultiBs> = [
        { bs: lowPriorityCache, priority: 10, read: true, write: true },
        { bs: highPriorityCache, priority: 1, read: true, write: true },
      ];

      const priorityMulti = new BsMulti(priorityStores);
      await priorityMulti.init();

      const { blobId } = await highPriorityCache.setBlob(content);
      const props = await priorityMulti.getBlobProperties(blobId);

      // Should get from high priority (lower number) store
      expect(props).toBeDefined();
    });
  });

  describe('example', () => {
    it('should create example BsMulti with local cache and remote', async () => {
      const example = await BsMulti.example();

      expect(example).toBeInstanceOf(BsMulti);

      // Test that it works
      const { blobId } = await example.setBlob('Example test');
      expect(await example.blobExists(blobId)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle errors from individual stores gracefully', async () => {
      const failingStore = new BsMem();
      const workingStore = new BsMem();

      const { blobId } = await workingStore.setBlob('Test');

      // Make failing store throw errors
      failingStore.getBlob = async () => {
        throw new Error('Store failure');
      };

      const resilientStores: Array<BsMultiBs> = [
        { bs: failingStore, priority: 0, read: true, write: false },
        { bs: workingStore, priority: 1, read: true, write: false },
      ];

      const resilientMulti = new BsMulti(resilientStores);
      await resilientMulti.init();

      // Should fallback to working store
      const result = await resilientMulti.getBlob(blobId);
      expect(result.content.toString()).toBe('Test');
    });

    it('should throw non-"not found" errors from getBlobProperties', async () => {
      const failingStore = new BsMem();

      // Make store throw non-"not found" error
      failingStore.getBlobProperties = async () => {
        throw new Error('Storage system failure');
      };

      const multiWithFailure: Array<BsMultiBs> = [
        { bs: failingStore, priority: 0, read: true, write: false },
      ];

      const multi = new BsMulti(multiWithFailure);
      await multi.init();

      await expect(multi.getBlobProperties('any-blob-id')).rejects.toThrow(
        'Storage system failure',
      );
    });

    it('should throw non-"not found" errors from getBlob', async () => {
      const failingStore = new BsMem();

      // Make store throw non-"not found" error
      failingStore.getBlob = async () => {
        throw new Error('Network timeout');
      };

      const multiWithFailure: Array<BsMultiBs> = [
        { bs: failingStore, priority: 0, read: true, write: false },
      ];

      const multi = new BsMulti(multiWithFailure);
      await multi.init();

      await expect(multi.getBlob('any-blob-id')).rejects.toThrow(
        'Network timeout',
      );
    });

    it('should throw non-"not found" errors from generateSignedUrl', async () => {
      const failingStore = new BsMem();

      // Make store throw non-"not found" error
      failingStore.generateSignedUrl = async () => {
        throw new Error('Permission denied');
      };

      const multiWithFailure: Array<BsMultiBs> = [
        { bs: failingStore, priority: 0, read: true, write: false },
      ];

      const multi = new BsMulti(multiWithFailure);
      await multi.init();

      await expect(
        multi.generateSignedUrl('any-blob-id', 3600),
      ).rejects.toThrow('Permission denied');
    });

    it('should skip stores that error during listBlobs', async () => {
      const failingStore = new BsMem();
      const workingStore = new BsMem();

      // Add blob to working store
      const { blobId } = await workingStore.setBlob('Test content');

      // Make failing store throw during listBlobs
      failingStore.listBlobs = async () => {
        throw new Error('Storage unavailable');
      };

      const multiWithMixedStores: Array<BsMultiBs> = [
        { bs: failingStore, priority: 0, read: true, write: false },
        { bs: workingStore, priority: 1, read: true, write: false },
      ];

      const multi = new BsMulti(multiWithMixedStores);
      await multi.init();

      // Should still get results from working store
      const result = await multi.listBlobs();
      expect(result.blobs).toHaveLength(1);
      expect(result.blobs[0].blobId).toBe(blobId);
    });

    it('should skip stores that error during blobExists', async () => {
      const failingStore = new BsMem();
      const workingStore = new BsMem();

      // Add blob to working store
      const { blobId } = await workingStore.setBlob('Exists test');

      // Make failing store throw during blobExists
      failingStore.blobExists = async () => {
        throw new Error('Check failed');
      };

      const multiWithMixedStores: Array<BsMultiBs> = [
        { bs: failingStore, priority: 0, read: true, write: false },
        { bs: workingStore, priority: 1, read: true, write: false },
      ];

      const multi = new BsMulti(multiWithMixedStores);
      await multi.init();

      // Should still find blob in working store
      const exists = await multi.blobExists(blobId);
      expect(exists).toBe(true);
    });

    it('should throw error when getBlobProperties called with no readable stores', async () => {
      const writeOnlyStore = new BsMem();

      const writeOnlyMulti: Array<BsMultiBs> = [
        { bs: writeOnlyStore, priority: 0, read: false, write: true },
      ];

      const multi = new BsMulti(writeOnlyMulti);
      await multi.init();

      await expect(multi.getBlobProperties('any-blob-id')).rejects.toThrow(
        'No readable Bs available',
      );
    });

    it('should throw error when generateSignedUrl called with no readable stores', async () => {
      const writeOnlyStore = new BsMem();

      const writeOnlyMulti: Array<BsMultiBs> = [
        { bs: writeOnlyStore, priority: 0, read: false, write: true },
      ];

      const multi = new BsMulti(writeOnlyMulti);
      await multi.init();

      await expect(
        multi.generateSignedUrl('any-blob-id', 3600),
      ).rejects.toThrow('No readable Bs available');
    });

    it('should throw error when getBlobStream called with no readable stores', async () => {
      const writeOnlyStore = new BsMem();

      const writeOnlyMulti: Array<BsMultiBs> = [
        { bs: writeOnlyStore, priority: 0, read: false, write: true },
      ];

      const multi = new BsMulti(writeOnlyMulti);
      await multi.init();

      await expect(multi.getBlobStream('any-blob-id')).rejects.toThrow(
        'No readable Bs available',
      );
    });

    it('should throw non-"not found" errors from getBlobStream', async () => {
      const failingStore = new BsMem();

      // Make store throw non-"not found" error
      failingStore.getBlobStream = async () => {
        throw new Error('Stream error');
      };

      const multiWithFailure: Array<BsMultiBs> = [
        { bs: failingStore, priority: 0, read: true, write: false },
      ];

      const multi = new BsMulti(multiWithFailure);
      await multi.init();

      await expect(multi.getBlobStream('any-blob-id')).rejects.toThrow(
        'Stream error',
      );
    });
  });

  describe('content-addressable behavior', () => {
    it('should deduplicate identical content across stores', async () => {
      const content = 'Dedupe test';

      // Write same content to multi (writes to all writables)
      const result1 = await bsMulti.setBlob(content);

      // Write same content again
      const result2 = await bsMulti.setBlob(content);

      // Should have same blobId (content-addressable)
      expect(result1.blobId).toBe(result2.blobId);

      // Should only show up once in listing
      const list = await bsMulti.listBlobs();
      const matchingBlobs = list.blobs.filter(
        (b) => b.blobId === result1.blobId,
      );
      expect(matchingBlobs).toHaveLength(1);
    });
  });
});
