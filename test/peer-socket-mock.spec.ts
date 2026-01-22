// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BsMem, PeerSocketMock } from '../src';

describe('PeerSocketMock', () => {
  let bsMem: BsMem;
  let socket: PeerSocketMock;

  beforeEach(() => {
    bsMem = new BsMem();
    socket = new PeerSocketMock(bsMem);
  });

  afterEach(async () => {
    socket.disconnect();
  });

  describe('connection lifecycle', () => {
    it('should connect successfully', () => {
      expect(socket.connected).toBe(false);
      socket.connect();
      expect(socket.connected).toBe(true);
    });

    it('should disconnect successfully', () => {
      socket.connect();
      expect(socket.connected).toBe(true);
      socket.disconnect();
      expect(socket.connected).toBe(false);
    });

    it('should handle multiple connects idempotently', () => {
      socket.connect();
      socket.connect();
      socket.connect();
      expect(socket.connected).toBe(true);
    });

    it('should handle multiple disconnects idempotently', () => {
      socket.connect();
      socket.disconnect();
      socket.disconnect();
      socket.disconnect();
      expect(socket.connected).toBe(false);
    });
  });

  describe('event handling', () => {
    beforeEach(() => {
      socket.connect();
    });

    it('should handle setBlob event', async () => {
      await new Promise<void>((resolve) => {
        socket.emit('setBlob', 'Hello', (error: Error | null, result: any) => {
          expect(error).toBeNull();
          expect(result.blobId).toBeDefined();
          expect(result.size).toBe(5);
          resolve();
        });
      });
    });

    it('should handle getBlob event', async () => {
      const { blobId } = await bsMem.setBlob('Test content');

      socket.emit('getBlob', blobId, {}, (error: Error | null, result: any) => {
        expect(error).toBeNull();
        expect(result.content.toString()).toBe('Test content');
      });
    });

    it('should handle getBlobStream event', async () => {
      const { blobId } = await bsMem.setBlob('Stream content');

      await new Promise<void>((resolve) => {
        socket.emit(
          'getBlobStream',
          blobId,
          {},
          async (error: Error | null, result: any) => {
            expect(error).toBeNull();
            expect(result).toBeInstanceOf(ReadableStream);

            // Read the stream
            const reader = result.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const content = Buffer.concat(chunks).toString();
            expect(content).toBe('Stream content');
            resolve();
          },
        );
      });
    });

    it('should handle deleteBlob event', async () => {
      const { blobId } = await bsMem.setBlob('Delete me');

      socket.emit('deleteBlob', blobId, (error: Error | null) => {
        expect(error).toBeNull();
      });
    });

    it('should handle blobExists event', async () => {
      const { blobId } = await bsMem.setBlob('Exists');

      socket.emit(
        'blobExists',
        blobId,
        (error: Error | null, exists: boolean) => {
          expect(error).toBeNull();
          expect(exists).toBe(true);
        },
      );
    });

    it('should handle getBlobProperties event', async () => {
      const { blobId } = await bsMem.setBlob('Properties');

      socket.emit(
        'getBlobProperties',
        blobId,
        (error: Error | null, properties: any) => {
          expect(error).toBeNull();
          expect(properties.blobId).toBe(blobId);
          expect(properties.size).toBe(10);
        },
      );
    });

    it('should handle listBlobs event', () => {
      socket.emit(
        'listBlobs',
        { maxResults: 10 },
        (error: Error | null, result: any) => {
          expect(error).toBeNull();
          expect(result.blobs).toBeDefined();
          expect(Array.isArray(result.blobs)).toBe(true);
        },
      );
    });

    it('should handle generateSignedUrl event', async () => {
      const { blobId } = await bsMem.setBlob('URL test');

      socket.emit(
        'generateSignedUrl',
        blobId,
        3600,
        'read',
        (error: Error | null, url: string) => {
          expect(error).toBeNull();
          expect(url).toContain(blobId);
        },
      );
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      socket.connect();
    });

    it('should propagate errors for getBlob with invalid blobId', async () => {
      await new Promise<void>((resolve) => {
        socket.emit(
          'getBlob',
          'invalid-id',
          {},
          (error: Error | null, result: any) => {
            expect(error).toBeDefined();
            expect(error?.message).toContain('Blob not found');
            expect(result).toBeUndefined();
            resolve();
          },
        );
      });
    });

    it('should propagate errors for deleteBlob with invalid blobId', async () => {
      await new Promise<void>((resolve) => {
        socket.emit('deleteBlob', 'invalid-id', (error: Error | null) => {
          expect(error).toBeDefined();
          expect(error?.message).toContain('Blob not found');
          resolve();
        });
      });
    });

    it('should propagate errors for getBlobProperties with invalid blobId', async () => {
      await new Promise<void>((resolve) => {
        socket.emit(
          'getBlobProperties',
          'invalid-id',
          (error: Error | null, properties: any) => {
            expect(error).toBeDefined();
            expect(error?.message).toContain('Blob not found');
            expect(properties).toBeUndefined();
            resolve();
          },
        );
      });
    });

    it('should propagate errors for getBlobStream with invalid blobId', async () => {
      await new Promise<void>((resolve) => {
        socket.emit(
          'getBlobStream',
          'invalid-id',
          {},
          (error: Error | null, result: any) => {
            expect(error).toBeDefined();
            expect(error?.message).toContain('Blob not found');
            expect(result).toBeUndefined();
            resolve();
          },
        );
      });
    });
  });

  describe('stream handling', () => {
    beforeEach(() => {
      socket.connect();
    });

    it('should handle ReadableStream input for setBlob', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Stream data'));
          controller.close();
        },
      });

      await new Promise<void>((resolve) => {
        socket.emit('setBlob', stream, (error: Error | null, result: any) => {
          expect(error).toBeNull();
          expect(result.blobId).toBeDefined();
          expect(result.size).toBe(11);
          resolve();
        });
      });
    });

    it('should handle empty stream input', async () => {
      const emptyStream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      await new Promise<void>((resolve) => {
        socket.emit(
          'setBlob',
          emptyStream,
          (error: Error | null, result: any) => {
            expect(error).toBeNull();
            expect(result.size).toBe(0);
            resolve();
          },
        );
      });
    });

    it('should handle Buffer input for setBlob', async () => {
      const buffer = Buffer.from('Buffer data');

      await new Promise<void>((resolve) => {
        socket.emit('setBlob', buffer, (error: Error | null, result: any) => {
          expect(error).toBeNull();
          expect(result.size).toBe(11);
          resolve();
        });
      });
    });
  });

  describe('options handling', () => {
    beforeEach(() => {
      socket.connect();
    });

    it('should handle listBlobs with options', async () => {
      await bsMem.setBlob('Test 1');
      await bsMem.setBlob('Test 2');
      await bsMem.setBlob('Test 3');

      socket.emit(
        'listBlobs',
        { maxResults: 2 },
        (error: Error | null, result: any) => {
          expect(error).toBeNull();
          expect(result.blobs.length).toBeLessThanOrEqual(2);
        },
      );
    });

    it('should handle listBlobs with prefix filter', async () => {
      const { blobId } = await bsMem.setBlob('Prefix test');
      const prefix = blobId.substring(0, 5);

      socket.emit(
        'listBlobs',
        { prefix },
        (error: Error | null, result: any) => {
          expect(error).toBeNull();
          result.blobs.forEach((blob: any) => {
            expect(blob.blobId.startsWith(prefix)).toBe(true);
          });
        },
      );
    });

    it('should handle getBlob with download options', async () => {
      const { blobId } = await bsMem.setBlob('Download test');

      await new Promise<void>((resolve) => {
        socket.emit(
          'getBlob',
          blobId,
          { range: { start: 0, end: 8 } },
          (error: Error | null, result: any) => {
            expect(error).toBeNull();
            expect(result.content.toString()).toBe('Download');
            resolve();
          },
        );
      });
    });
  });

  describe('method chaining', () => {
    it('should return socket for connect', () => {
      const result = socket.connect();
      expect(result).toBe(socket);
    });

    it('should return socket for disconnect', () => {
      socket.connect();
      const result = socket.disconnect();
      expect(result).toBe(socket);
    });
  });

  describe('unsupported methods', () => {
    it('should have no-op on, off, and removeAllListeners', () => {
      expect(() => socket.on('test', () => {})).not.toThrow();
      expect(() => socket.off('test', () => {})).not.toThrow();
      expect(() => socket.removeAllListeners()).not.toThrow();
    });

    it('should handle off with non-existent listener', () => {
      const listener = () => {};
      socket.on('testEvent', listener);
      socket.off('testEvent', () => {}); // Different listener
      expect(() => socket.off('testEvent', listener)).not.toThrow();
    });

    it('should handle removeAllListeners with specific event', () => {
      socket.on('event1', () => {});
      socket.on('event2', () => {});
      socket.removeAllListeners('event1');
      expect(() => socket.removeAllListeners('event2')).not.toThrow();
    });

    it('should handle removeAllListeners without event name', () => {
      socket.on('event1', () => {});
      socket.on('event2', () => {});
      socket.removeAllListeners();
      expect(() => socket.removeAllListeners()).not.toThrow();
    });

    it('should throw error for unsupported event', () => {
      socket.connect();
      expect(() => {
        socket.emit('unsupportedEvent', () => {});
      }).toThrow('Event unsupportedEvent not supported');
    });
  });

  describe('concurrent operations', () => {
    beforeEach(() => {
      socket.connect();
    });

    it('should handle multiple simultaneous setBlob calls', async () => {
      const promises: Promise<any>[] = [];

      for (let i = 0; i < 10; i++) {
        promises.push(
          new Promise((resolve) => {
            socket.emit(
              'setBlob',
              `Concurrent ${i}`,
              (error: Error | null, result: any) => {
                resolve({ error, result });
              },
            );
          }),
        );
      }

      const results = await Promise.all(promises);
      expect(results).toHaveLength(10);
      results.forEach((r) => {
        expect(r.error).toBeNull();
        expect(r.result.blobId).toBeDefined();
      });
    });

    it('should handle mixed read/write operations', async () => {
      const { blobId } = await bsMem.setBlob('Mixed ops');

      const promises = [
        new Promise((resolve) => {
          socket.emit('setBlob', 'New', (error: Error | null, result: any) => {
            resolve({ type: 'set', error, result });
          });
        }),
        new Promise((resolve) => {
          socket.emit(
            'getBlob',
            blobId,
            {},
            (error: Error | null, result: any) => {
              resolve({ type: 'get', error, result });
            },
          );
        }),
        new Promise((resolve) => {
          socket.emit(
            'blobExists',
            blobId,
            (error: Error | null, exists: boolean) => {
              resolve({ type: 'exists', error, exists });
            },
          );
        }),
      ];

      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);
      results.forEach((r: any) => {
        expect(r.error).toBeNull();
      });
    });
  });
});
