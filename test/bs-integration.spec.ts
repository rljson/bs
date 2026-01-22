// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem, BsPeer, BsServer, SocketMock } from '../src';
import { BlobProperties } from '../src/bs.ts';

describe('BsPeer and BsServer Integration', () => {
  let bsMem: BsMem;
  let server: BsServer;
  let client1Socket: SocketMock;
  let client2Socket: SocketMock;
  let client1: BsPeer;
  let client2: BsPeer;

  beforeEach(async () => {
    bsMem = new BsMem();
    server = new BsServer(bsMem);

    // Client 1
    client1Socket = new SocketMock();
    await server.addSocket(client1Socket);
    client1 = new BsPeer(client1Socket);
    await client1.init();

    // Client 2
    client2Socket = new SocketMock();
    await server.addSocket(client2Socket);
    client2 = new BsPeer(client2Socket);
    await client2.init();
  });

  afterEach(async () => {
    await client1.close();
    await client2.close();
    server.removeSocket(client1Socket);
    server.removeSocket(client2Socket);
  });

  describe('concurrent operations', () => {
    it('should handle concurrent blob uploads', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(client1.setBlob(`Blob ${i}`));
      }

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      results.forEach((result) => {
        expect(result.blobId).toBeDefined();
      });

      // Verify all blobs are in storage
      const list = await client1.listBlobs();
      expect(list.blobs).toHaveLength(10);
    });

    it('should handle concurrent reads by different clients', async () => {
      // Store blob
      const { blobId } = await client1.setBlob('Shared data');

      // Both clients read simultaneously
      const [result1, result2] = await Promise.all([
        client1.getBlob(blobId),
        client2.getBlob(blobId),
      ]);

      expect(result1.content.toString()).toBe('Shared data');
      expect(result2.content.toString()).toBe('Shared data');
    });

    it('should handle concurrent deletes safely', async () => {
      const { blobId } = await client1.setBlob('Delete me');

      // Both try to delete - first should succeed, second should fail
      const results = await Promise.allSettled([
        client1.deleteBlob(blobId),
        client2.deleteBlob(blobId),
      ]);

      // At least one should succeed
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      // Blob should be deleted
      expect(await bsMem.blobExists(blobId)).toBe(false);
    });
  });

  describe('data consistency', () => {
    it('should maintain consistency across clients', async () => {
      // Client 1 stores blob
      const { blobId } = await client1.setBlob('Consistent data');

      // Client 2 should immediately see it
      const exists = await client2.blobExists(blobId);
      expect(exists).toBe(true);

      const { content } = await client2.getBlob(blobId);
      expect(content.toString()).toBe('Consistent data');
    });

    it('should reflect deletions across clients', async () => {
      const { blobId } = await client1.setBlob('Will be deleted');

      // Both clients see it
      expect(await client1.blobExists(blobId)).toBe(true);
      expect(await client2.blobExists(blobId)).toBe(true);

      // Client 1 deletes
      await client1.deleteBlob(blobId);

      // Client 2 should not see it anymore
      expect(await client2.blobExists(blobId)).toBe(false);
    });

    it('should handle duplicate content correctly', async () => {
      const content = 'Duplicate content';

      const result1 = await client1.setBlob(content);
      const result2 = await client2.setBlob(content);

      // Should have same blobId (content-addressed)
      expect(result1.blobId).toBe(result2.blobId);

      // Should only have one blob
      const list = await client1.listBlobs();
      expect(list.blobs).toHaveLength(1);
    });
  });

  describe('large data handling', () => {
    it('should handle large blobs', async () => {
      // Create 1MB blob
      const largeContent = Buffer.alloc(1024 * 1024, 'x');
      const { blobId, size } = await client1.setBlob(largeContent);

      expect(size).toBe(1024 * 1024);

      // Retrieve and verify
      const { content } = await client2.getBlob(blobId);
      expect(content.length).toBe(1024 * 1024);
      expect(content.toString()).toBe(largeContent.toString());
    });

    it('should handle many small blobs', async () => {
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(client1.setBlob(`Small ${i}`));
      }

      await Promise.all(promises);

      const list = await client1.listBlobs();
      expect(list.blobs.length).toBeGreaterThanOrEqual(100);
    });
  });

  describe('pagination scenarios', () => {
    beforeEach(async () => {
      // Create test data
      for (let i = 0; i < 25; i++) {
        await client1.setBlob(`Test blob ${i.toString().padStart(2, '0')}`);
      }
    });

    it('should paginate correctly with different page sizes', async () => {
      let allBlobs: BlobProperties[] = [];
      let continuationToken: string | undefined;

      // Fetch in pages of 10
      do {
        const results = await client1.listBlobs({
          maxResults: 10,
          continuationToken,
        });
        allBlobs = allBlobs.concat(results.blobs);
        continuationToken = results.continuationToken;
      } while (continuationToken);

      expect(allBlobs).toHaveLength(25);
    });

    it('should handle empty pages', async () => {
      // Clear all blobs
      const list = await client1.listBlobs();
      for (const blob of list.blobs) {
        await client1.deleteBlob(blob.blobId);
      }

      const result = await client1.listBlobs({ maxResults: 10 });
      expect(result.blobs).toHaveLength(0);
      expect(result.continuationToken).toBeUndefined();
    });
  });

  describe('prefix filtering', () => {
    beforeEach(async () => {
      // Store blobs with known prefixes based on content
      await client1.setBlob('apple');
      await client1.setBlob('apricot');
      await client1.setBlob('banana');
      await client1.setBlob('cherry');
    });

    it('should filter by prefix correctly', async () => {
      // Get a blob ID to use as prefix
      const { blobId } = await client1.setBlob('test prefix');
      const prefix = blobId.substring(0, 5);

      const result = await client1.listBlobs({ prefix });

      // Should only get blobs with matching prefix
      result.blobs.forEach((blob) => {
        expect(blob.blobId.startsWith(prefix)).toBe(true);
      });
    });

    it('should handle non-matching prefix', async () => {
      const result = await client1.listBlobs({ prefix: 'ZZZZZ' });
      expect(result.blobs).toHaveLength(0);
    });
  });

  describe('stream handling', () => {
    it('should handle empty streams', async () => {
      const emptyStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const result = await client1.setBlob(emptyStream);
      expect(result.size).toBe(0);

      const { content } = await client2.getBlob(result.blobId);
      expect(content.length).toBe(0);
    });

    it('should handle streams with multiple chunks', async () => {
      const chunks = ['Hello', ' ', 'World', '!'];
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((chunk) => {
            controller.enqueue(new TextEncoder().encode(chunk));
          });
          controller.close();
        },
      });

      const result = await client1.setBlob(stream);
      const { content } = await client2.getBlob(result.blobId);

      expect(content.toString()).toBe('Hello World!');
    });
  });

  describe('error propagation', () => {
    it('should propagate errors through socket layer', async () => {
      await expect(client1.getBlob('invalid')).rejects.toThrow(
        'Blob not found',
      );
      await expect(client2.deleteBlob('invalid')).rejects.toThrow(
        'Blob not found',
      );
    });

    it('should handle errors in one client without affecting others', async () => {
      // Client 1 makes invalid request
      const error1 = client1.getBlob('invalid').catch((e) => e);

      // Client 2 makes valid request
      const { blobId } = await client2.setBlob('Valid');

      await expect(error1).resolves.toBeInstanceOf(Error);
      expect(await client2.blobExists(blobId)).toBe(true);
    });
  });

  describe('connection lifecycle', () => {
    it('should handle client disconnect gracefully', async () => {
      const { blobId } = await client1.setBlob('Before disconnect');

      await client1.close();
      server.removeSocket(client1Socket);

      // Other client should still work
      expect(await client2.blobExists(blobId)).toBe(true);
    });

    it('should handle multiple client connections and disconnections', async () => {
      const client3Socket = new SocketMock();
      await server.addSocket(client3Socket);
      const client3 = new BsPeer(client3Socket);
      await client3.init();

      await client3.setBlob('Test');

      await client1.close();
      server.removeSocket(client1Socket);

      // Client 2 and 3 should still work
      const list2 = await client2.listBlobs();
      const list3 = await client3.listBlobs();
      expect(list2.blobs).toHaveLength(1);
      expect(list3.blobs).toHaveLength(1);

      await client3.close();
      server.removeSocket(client3Socket);
    });
  });

  describe('signed URLs', () => {
    it('should generate unique URLs for different expiration times', async () => {
      const { blobId } = await client1.setBlob('URL test');

      const url1 = await client1.generateSignedUrl(blobId, 3600);
      const url2 = await client1.generateSignedUrl(blobId, 7200);

      expect(url1).not.toBe(url2);
      expect(url1).toContain(blobId);
      expect(url2).toContain(blobId);
    });

    it('should handle different permissions', async () => {
      const { blobId } = await client1.setBlob('Permission test');

      const readUrl = await client1.generateSignedUrl(blobId, 3600, 'read');
      const deleteUrl = await client1.generateSignedUrl(blobId, 3600, 'delete');

      expect(readUrl).toContain('permissions=read');
      expect(deleteUrl).toContain('permissions=delete');
    });
  });
});
