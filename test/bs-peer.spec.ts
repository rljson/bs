// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem, BsPeer, PeerSocketMock } from '../src';

describe('BsPeer', () => {
  let bsMem: BsMem;
  let socket: PeerSocketMock;
  let bsPeer: BsPeer;

  beforeEach(async () => {
    // Create underlying BsMem instance
    bsMem = new BsMem();

    // Create peer socket mock that forwards to BsMem
    socket = new PeerSocketMock(bsMem);

    // Create BsPeer client
    bsPeer = new BsPeer(socket);
    await bsPeer.init();
  });

  afterEach(async () => {
    await bsPeer.close();
  });

  describe('lifecycle', () => {
    it('should initialize and connect', async () => {
      expect(bsPeer.isOpen).toBe(true);
      expect(socket.connected).toBe(true);
    });

    it('should close and disconnect', async () => {
      await bsPeer.close();
      expect(bsPeer.isOpen).toBe(false);
      expect(socket.connected).toBe(false);
    });

    it('should wait for ready state', async () => {
      await expect(bsPeer.isReady()).resolves.toBeUndefined();
    });

    it('should reject when not ready', async () => {
      await bsPeer.close();
      await expect(bsPeer.isReady()).rejects.toBeUndefined();
    });

    it('should handle stream read errors', async () => {
      const errorStream = new ReadableStream({
        start(controller) {
          controller.error(new Error('Stream read failed'));
        },
      });

      await expect(bsPeer.setBlob(errorStream)).rejects.toThrow(
        'Stream read failed',
      );
    });

    it('should handle stream chunk processing errors', async () => {
      let chunkCount = 0;
      const errorStream = new ReadableStream({
        async pull(controller) {
          if (chunkCount === 0) {
            controller.enqueue(new TextEncoder().encode('first chunk'));
            chunkCount++;
          } else {
            throw new Error('Chunk processing failed');
          }
        },
      });

      await expect(bsPeer.setBlob(errorStream)).rejects.toThrow(
        'Chunk processing failed',
      );
    });
  });

  describe('setBlob', () => {
    it('should store a blob from Buffer', async () => {
      const content = Buffer.from('Hello, Peer!');
      const result = await bsPeer.setBlob(content);

      expect(result.blobId).toBeDefined();
      expect(result.blobId).toHaveLength(22);
      expect(result.size).toBe(12);
      expect(result.createdAt).toBeInstanceOf(Date);

      // Verify blob is actually stored in BsMem
      const exists = await bsMem.blobExists(result.blobId);
      expect(exists).toBe(true);
      const { content: stored } = await bsMem.getBlob(result.blobId);
      expect(stored.toString()).toBe('Hello, Peer!');
    });

    it('should store a blob from string', async () => {
      const content = 'Peer string content';
      const result = await bsPeer.setBlob(content);

      expect(result.blobId).toBeDefined();
      expect(result.size).toBe(19);

      // Verify blob is actually stored in BsMem
      const exists = await bsMem.blobExists(result.blobId);
      expect(exists).toBe(true);
    });

    it('should store a blob from ReadableStream', async () => {
      const content = 'Stream from peer';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          controller.close();
        },
      });

      const result = await bsPeer.setBlob(stream);

      expect(result.blobId).toBeDefined();
      expect(result.size).toBe(16);

      // Verify blob is actually stored in BsMem
      const exists = await bsMem.blobExists(result.blobId);
      expect(exists).toBe(true);
      const { content: stored } = await bsMem.getBlob(result.blobId);
      expect(stored.toString()).toBe('Stream from peer');
    });

    it('should handle setBlob errors with Buffer', async () => {
      // Create a mock socket that throws errors
      const errorSocket = new PeerSocketMock(bsMem);
      const originalEmit = errorSocket.emit.bind(errorSocket);
      errorSocket.emit = (eventName: string | symbol, ...args: unknown[]) => {
        if (eventName === 'setBlob') {
          const cb = args[args.length - 1] as (error: Error | null) => void;
          cb(new Error('Storage failed'));
          return true;
        }
        return originalEmit(eventName, ...args);
      };

      const errorPeer = new BsPeer(errorSocket);
      await errorPeer.init();

      await expect(errorPeer.setBlob('test')).rejects.toThrow('Storage failed');
      await errorPeer.close();
    });

    it('should handle setBlob errors with ReadableStream', async () => {
      // Create a mock socket that throws errors
      const errorSocket = new PeerSocketMock(bsMem);
      const originalEmit = errorSocket.emit.bind(errorSocket);
      errorSocket.emit = (eventName: string | symbol, ...args: unknown[]) => {
        if (eventName === 'setBlob') {
          const cb = args[args.length - 1] as (error: Error | null) => void;
          cb(new Error('Storage failed'));
          return true;
        }
        return originalEmit(eventName, ...args);
      };

      const errorPeer = new BsPeer(errorSocket);
      await errorPeer.init();

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('test'));
          controller.close();
        },
      });

      await expect(errorPeer.setBlob(stream)).rejects.toThrow('Storage failed');
      await errorPeer.close();
    });
  });

  describe('getBlob', () => {
    it('should retrieve a blob by ID', async () => {
      const content = Buffer.from('Retrieve me');
      const { blobId } = await bsPeer.setBlob(content);

      const { content: retrieved } = await bsPeer.getBlob(blobId);

      expect(retrieved.toString()).toBe('Retrieve me');
    });

    it('should throw error for non-existent blob', async () => {
      await expect(bsPeer.getBlob('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );
    });
  });

  describe('getBlobStream', () => {
    it('should retrieve a blob as stream', async () => {
      const content = Buffer.from('Stream me');
      const { blobId } = await bsPeer.setBlob(content);

      const stream = await bsPeer.getBlobStream(blobId);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const result = Buffer.concat(chunks);
      expect(result.toString()).toBe('Stream me');
    });

    it('should throw error for non-existent blob stream', async () => {
      await expect(bsPeer.getBlobStream('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );
    });
  });

  describe('deleteBlob', () => {
    it('should delete a blob', async () => {
      const content = Buffer.from('Delete me');
      const { blobId } = await bsPeer.setBlob(content);

      // Verify it exists in BsMem first
      expect(await bsMem.blobExists(blobId)).toBe(true);

      await bsPeer.deleteBlob(blobId);

      // Verify it's deleted from BsMem
      expect(await bsMem.blobExists(blobId)).toBe(false);
      await expect(bsPeer.getBlob(blobId)).rejects.toThrow('Blob not found');
    });

    it('should throw error when deleting non-existent blob', async () => {
      await expect(bsPeer.deleteBlob('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );
    });
  });

  describe('blobExists', () => {
    it('should return true for existing blob', async () => {
      const content = Buffer.from('Exists');
      const { blobId } = await bsPeer.setBlob(content);

      const exists = await bsPeer.blobExists(blobId);
      expect(exists).toBe(true);
    });

    it('should return false for non-existent blob', async () => {
      const exists = await bsPeer.blobExists('nonexistent123');
      expect(exists).toBe(false);
    });

    it('should handle blobExists socket errors', async () => {
      // Create a mock socket that throws errors for blobExists
      const errorSocket = new PeerSocketMock(bsMem);
      const originalEmit = errorSocket.emit.bind(errorSocket);
      errorSocket.emit = (eventName: string | symbol, ...args: unknown[]) => {
        if (eventName === 'blobExists') {
          const cb = args[args.length - 1] as (error: Error | null) => void;
          cb(new Error('Socket error'));
          return true;
        }
        return originalEmit(eventName, ...args);
      };

      const errorPeer = new BsPeer(errorSocket);
      await errorPeer.init();

      await expect(errorPeer.blobExists('any-id')).rejects.toThrow(
        'Socket error',
      );
      await errorPeer.close();
    });
  });

  describe('getBlobProperties', () => {
    it('should return blob properties', async () => {
      const content = Buffer.from('Properties test');
      const { blobId } = await bsPeer.setBlob(content);

      const properties = await bsPeer.getBlobProperties(blobId);

      expect(properties.blobId).toBe(blobId);
      expect(properties.size).toBe(15);
      expect(properties.createdAt).toBeInstanceOf(Date);
    });

    it('should throw error for non-existent blob', async () => {
      await expect(bsPeer.getBlobProperties('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );
    });
  });

  describe('listBlobs', () => {
    it('should list all blobs', async () => {
      await bsPeer.setBlob('Blob 1');
      await bsPeer.setBlob('Blob 2');
      await bsPeer.setBlob('Blob 3');

      const result = await bsPeer.listBlobs();

      expect(result.blobs).toHaveLength(3);
      expect(result.continuationToken).toBeUndefined();
    });

    it('should list empty blobs', async () => {
      const result = await bsPeer.listBlobs();

      expect(result.blobs).toHaveLength(0);
      expect(result.continuationToken).toBeUndefined();
    });

    it('should filter by prefix', async () => {
      const { blobId: id1 } = await bsPeer.setBlob('Prefix test 1');
      await bsPeer.setBlob('Other content');

      const prefix = id1.substring(0, 5);
      const result = await bsPeer.listBlobs({ prefix });

      expect(result.blobs.length).toBeGreaterThanOrEqual(1);
      expect(result.blobs.every((b) => b.blobId.startsWith(prefix))).toBe(true);
    });

    it('should support pagination', async () => {
      await bsPeer.setBlob('Blob 1');
      await bsPeer.setBlob('Blob 2');
      await bsPeer.setBlob('Blob 3');

      const page1 = await bsPeer.listBlobs({ maxResults: 2 });

      expect(page1.blobs).toHaveLength(2);
      expect(page1.continuationToken).toBeDefined();

      const page2 = await bsPeer.listBlobs({
        maxResults: 2,
        continuationToken: page1.continuationToken,
      });

      expect(page2.blobs).toHaveLength(1);
      expect(page2.continuationToken).toBeUndefined();
    });

    it('should handle listBlobs errors', async () => {
      // Create a mock socket that throws errors
      const errorSocket = new PeerSocketMock(bsMem);
      const originalEmit = errorSocket.emit.bind(errorSocket);
      errorSocket.emit = (eventName: string | symbol, ...args: unknown[]) => {
        if (eventName === 'listBlobs') {
          const cb = args[args.length - 1] as (error: Error | null) => void;
          cb(new Error('List failed'));
          return true;
        }
        return originalEmit(eventName, ...args);
      };

      const errorPeer = new BsPeer(errorSocket);
      await errorPeer.init();

      await expect(errorPeer.listBlobs()).rejects.toThrow('List failed');
      await errorPeer.close();
    });
  });

  describe('generateSignedUrl', () => {
    it('should generate a signed URL', async () => {
      const content = Buffer.from('URL test');
      const { blobId } = await bsPeer.setBlob(content);

      const url = await bsPeer.generateSignedUrl(blobId, 3600);

      expect(url).toContain(blobId);
      expect(url).toContain('expires=');
    });

    it('should accept custom expiration', async () => {
      const content = Buffer.from('URL test with expiry');
      const { blobId } = await bsPeer.setBlob(content);

      const url = await bsPeer.generateSignedUrl(blobId, 7200);

      expect(url).toContain(blobId);
    });

    it('should throw error for non-existent blob', async () => {
      await expect(
        bsPeer.generateSignedUrl('nonexistent123', 3600),
      ).rejects.toThrow('Blob not found');
    });
  });

  describe('content deduplication', () => {
    it('should deduplicate identical content', async () => {
      const content = Buffer.from('Duplicate content');
      const result1 = await bsPeer.setBlob(content);
      const result2 = await bsPeer.setBlob(content);

      expect(result1.blobId).toBe(result2.blobId);

      const list = await bsPeer.listBlobs();
      expect(list.blobs).toHaveLength(1);
    });
  });
});
