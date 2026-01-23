// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem, BsPeer, BsServer, SocketMock } from '../src';

describe('BsServer', () => {
  let bsMem: BsMem;
  let server: BsServer;
  let clientSocket: SocketMock;
  let bsPeer: BsPeer;

  beforeEach(async () => {
    // Create underlying BsMem instance
    bsMem = new BsMem();

    // Create server
    server = new BsServer(bsMem);

    // Create client socket
    clientSocket = new SocketMock();

    // Add socket to server
    await server.addSocket(clientSocket);

    // Create BsPeer client using the socket
    bsPeer = new BsPeer(clientSocket);
    await bsPeer.init();
  });

  afterEach(async () => {
    await bsPeer.close();
    server.removeSocket(clientSocket);
  });

  describe('lifecycle', () => {
    it('should add and remove sockets', async () => {
      const socket2 = new SocketMock();
      await server.addSocket(socket2);
      server.removeSocket(socket2);
    });
  });

  describe('setBlob', () => {
    it('should store a blob through server', async () => {
      const content = Buffer.from('Server test');
      const result = await bsPeer.setBlob(content);

      expect(result.blobId).toBeDefined();
      expect(result.size).toBe(11);

      // Verify it's stored in underlying BsMem
      const exists = await bsMem.blobExists(result.blobId);
      expect(exists).toBe(true);
    });

    it('should handle multiple clients', async () => {
      // Create second client
      const socket2 = new SocketMock();
      await server.addSocket(socket2);
      const peer2 = new BsPeer(socket2);
      await peer2.init();

      // Store blob from first client
      const content1 = Buffer.from('Client 1');
      const result1 = await bsPeer.setBlob(content1);

      // Store blob from second client
      const content2 = Buffer.from('Client 2');
      const result2 = await peer2.setBlob(content2);

      // Both should be in BsMem
      expect(await bsMem.blobExists(result1.blobId)).toBe(true);
      expect(await bsMem.blobExists(result2.blobId)).toBe(true);

      // Both clients should see both blobs
      const list1 = await bsPeer.listBlobs();
      const list2 = await peer2.listBlobs();
      expect(list1.blobs).toHaveLength(2);
      expect(list2.blobs).toHaveLength(2);

      await peer2.close();
      server.removeSocket(socket2);
    });
  });

  describe('getBlob', () => {
    it('should retrieve blob through server', async () => {
      const content = Buffer.from('Retrieve through server');
      const { blobId } = await bsPeer.setBlob(content);

      const { content: retrieved } = await bsPeer.getBlob(blobId);

      expect(retrieved.toString()).toBe('Retrieve through server');
    });
  });

  describe('getBlobStream', () => {
    it('should retrieve blob stream through server', async () => {
      const content = Buffer.from('Stream through server');
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
      expect(result.toString()).toBe('Stream through server');
    });
  });

  describe('deleteBlob', () => {
    it('should delete blob through server', async () => {
      const content = Buffer.from('Delete through server');
      const { blobId } = await bsPeer.setBlob(content);

      // Verify it exists
      expect(await bsMem.blobExists(blobId)).toBe(true);

      await bsPeer.deleteBlob(blobId);

      // Verify it's deleted from BsMem
      expect(await bsMem.blobExists(blobId)).toBe(false);
    });
  });

  describe('blobExists', () => {
    it('should check blob existence through server', async () => {
      const content = Buffer.from('Exists check');
      const { blobId } = await bsPeer.setBlob(content);

      const exists = await bsPeer.blobExists(blobId);
      expect(exists).toBe(true);

      const notExists = await bsPeer.blobExists('nonexistent123');
      expect(notExists).toBe(false);
    });
  });

  describe('getBlobProperties', () => {
    it('should get properties through server', async () => {
      const content = Buffer.from('Properties check');
      const { blobId } = await bsPeer.setBlob(content);

      const properties = await bsPeer.getBlobProperties(blobId);

      expect(properties.blobId).toBe(blobId);
      expect(properties.size).toBe(16);
      expect(properties.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('listBlobs', () => {
    it('should list blobs through server', async () => {
      await bsPeer.setBlob('Blob 1');
      await bsPeer.setBlob('Blob 2');
      await bsPeer.setBlob('Blob 3');

      const result = await bsPeer.listBlobs();

      expect(result.blobs).toHaveLength(3);
    });

    it('should support pagination through server', async () => {
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
    });
  });

  describe('generateSignedUrl', () => {
    it('should generate signed URL through server', async () => {
      const content = Buffer.from('URL generation');
      const { blobId } = await bsPeer.setBlob(content);

      const url = await bsPeer.generateSignedUrl(blobId, 3600);

      expect(url).toContain(blobId);
      expect(url).toContain('expires=');
    });
  });

  describe('error handling', () => {
    it('should propagate errors from BsMem to client', async () => {
      await expect(bsPeer.getBlob('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );

      await expect(bsPeer.deleteBlob('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );

      await expect(bsPeer.getBlobProperties('nonexistent123')).rejects.toThrow(
        'Blob not found',
      );

      await expect(
        bsPeer.generateSignedUrl('nonexistent123', 3600),
      ).rejects.toThrow('Blob not found');
    });
  });
});
