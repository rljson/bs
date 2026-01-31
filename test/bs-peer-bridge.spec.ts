// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem } from '../src/bs-mem';
import { BsPeerBridge } from '../src/bs-peer-bridge';
import { SocketMock } from '../src/socket-mock';

describe('BsPeerBridge', () => {
  let bs: BsMem;
  let socket: SocketMock;
  let bridge: BsPeerBridge;

  beforeEach(async () => {
    bs = new BsMem();
    socket = new SocketMock();
    bridge = new BsPeerBridge(bs, socket);
  });

  describe('constructor', () => {
    it('should create an instance with bs and socket', () => {
      expect(bridge).toBeInstanceOf(BsPeerBridge);
      expect(bridge.bs).toBe(bs);
      expect(bridge.socket).toBe(socket);
    });
  });

  describe('start()', () => {
    it('should register connect and disconnect handlers', () => {
      const connectSpy = vi.spyOn(socket, 'on');
      bridge.start();

      expect(connectSpy).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(connectSpy).toHaveBeenCalledWith(
        'disconnect',
        expect.any(Function),
      );
    });

    it('should automatically register read-only Bs methods (PULL architecture)', () => {
      const onSpy = vi.spyOn(socket, 'on');
      bridge.start();

      // Only read operations should be registered (PULL-only)
      const readMethods = [
        'getBlob',
        'getBlobStream',
        'blobExists',
        'getBlobProperties',
        'listBlobs',
      ];

      for (const method of readMethods) {
        expect(onSpy).toHaveBeenCalledWith(method, expect.any(Function));
      }

      // Write operations should NOT be registered
      const writeMethods = ['setBlob', 'deleteBlob', 'generateSignedUrl'];
      for (const method of writeMethods) {
        const calls = onSpy.mock.calls.filter((call) => call[0] === method);
        expect(calls.length).toBe(0);
      }
    });
  });

  describe('stop()', () => {
    it('should remove all event handlers', () => {
      bridge.start();
      const offSpy = vi.spyOn(socket, 'off');

      bridge.stop();

      expect(offSpy).toHaveBeenCalled();
    });

    it('should clear the event handlers map', () => {
      bridge.start();
      bridge.stop();

      // Verify handlers are cleared by checking internal state
      expect(bridge['_eventHandlers'].size).toBe(0);
    });
  });

  describe('registerEvent()', () => {
    it('should register a custom event handler', () => {
      const onSpy = vi.spyOn(socket, 'on');
      bridge.registerEvent('customEvent');

      expect(onSpy).toHaveBeenCalledWith('customEvent', expect.any(Function));
    });

    it('should map event name to different bs method name', () => {
      const onSpy = vi.spyOn(socket, 'on');
      bridge.registerEvent('customEvent', 'setBlob');

      expect(onSpy).toHaveBeenCalledWith('customEvent', expect.any(Function));
    });

    it('should handle read method calls through registered events', async () => {
      bridge.start();

      // First store a blob directly in the bs instance
      const { blobId } = await bs.setBlob('Test content');

      let callbackResult: any;
      let callbackError: any;

      const callback = (error: any, result: any) => {
        callbackError = error;
        callbackResult = result;
      };

      // Trigger a read event (getBlob is registered)
      socket.emit('getBlob', blobId, callback);

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callbackResult).toBeDefined();
      expect(callbackResult.content.toString()).toBe('Test content');
      expect(callbackError).toBeNull();
    });

    it('should handle errors in method calls', async () => {
      bridge.start();

      let callbackResult: any;
      let callbackError: any;

      const callback = (error: any, result: any) => {
        callbackError = error;
        callbackResult = result;
      };

      // Trigger getBlob with non-existent blobId
      socket.emit('getBlob', 'nonexistent-blob-id', callback);

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callbackResult).toBeNull();
      expect(callbackError).toBeDefined();
      expect(callbackError.message).toContain('Blob not found');
    });

    it('should handle non-existent methods gracefully', async () => {
      bridge.registerEvent('nonExistentMethod');

      let callbackResult: any;
      let callbackError: any;

      const callback = (error: any, result: any) => {
        callbackError = error;
        callbackResult = result;
      };

      socket.emit('nonExistentMethod', callback);

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callbackResult).toBeNull();
      expect(callbackError).toBeDefined();
      expect(callbackError.message).toContain('not found on Bs instance');
    });
  });

  describe('registerEvents()', () => {
    it('should register multiple events at once', () => {
      const onSpy = vi.spyOn(socket, 'on');
      const events = ['event1', 'event2', 'event3'];

      bridge.registerEvents(events);

      for (const event of events) {
        expect(onSpy).toHaveBeenCalledWith(event, expect.any(Function));
      }
    });
  });

  describe('unregisterEvent()', () => {
    it('should remove a specific event handler', () => {
      bridge.start();
      const offSpy = vi.spyOn(socket, 'off');

      bridge.unregisterEvent('getBlob');

      expect(offSpy).toHaveBeenCalledWith('getBlob', expect.any(Function));
    });

    it('should not throw if event does not exist', () => {
      expect(() => {
        bridge.unregisterEvent('nonExistentEvent');
      }).not.toThrow();
    });

    it('should prevent events from firing after unregistration', async () => {
      bridge.start();
      bridge.unregisterEvent('getBlob');

      let callbackCalled = false;
      const callback = () => {
        callbackCalled = true;
      };

      socket.emit('getBlob', 'some-blob-id', callback);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(callbackCalled).toBe(false);
    });
  });

  describe('emitToSocket()', () => {
    it('should emit events through the socket', () => {
      const emitSpy = vi.spyOn(socket, 'emit');
      const testData = { blobId: 'test-id' };

      bridge.emitToSocket('testEvent', testData);

      expect(emitSpy).toHaveBeenCalledWith('testEvent', testData);
    });

    it('should emit multiple arguments', () => {
      const emitSpy = vi.spyOn(socket, 'emit');

      bridge.emitToSocket('testEvent', 'arg1', 'arg2', 'arg3');

      expect(emitSpy).toHaveBeenCalledWith('testEvent', 'arg1', 'arg2', 'arg3');
    });
  });

  describe('callBsAndEmit()', () => {
    it('should call bs method and emit result', async () => {
      const emitSpy = vi.spyOn(socket, 'emit');
      const content = 'Test content for callBsAndEmit';

      await bridge.callBsAndEmit('setBlob', 'setBlobResult', content);

      expect(emitSpy).toHaveBeenCalledWith(
        'setBlobResult',
        null,
        expect.objectContaining({
          blobId: expect.any(String),
          size: expect.any(Number),
        }),
      );
    });

    it('should emit error if bs method fails', async () => {
      const emitSpy = vi.spyOn(socket, 'emit');

      await bridge.callBsAndEmit('getBlob', 'getBlobResult', 'nonexistent-id');

      expect(emitSpy).toHaveBeenCalledWith(
        'getBlobResult',
        expect.objectContaining({
          message: expect.stringContaining('Blob not found'),
        }),
        null,
      );
    });

    it('should emit error if method does not exist', async () => {
      const emitSpy = vi.spyOn(socket, 'emit');

      await bridge.callBsAndEmit('nonExistentMethod', 'result');

      expect(emitSpy).toHaveBeenCalledWith(
        'result',
        expect.objectContaining({
          message: expect.stringContaining('not found on Bs instance'),
        }),
        null,
      );
    });

    it('should pass arguments to bs method', async () => {
      const setBlobSpy = vi.spyOn(bs, 'setBlob');
      const emitSpy = vi.spyOn(socket, 'emit');
      const content = 'Test content';

      await bridge.callBsAndEmit('setBlob', 'setBlobResult', content);

      expect(setBlobSpy).toHaveBeenCalledWith(content);
      expect(emitSpy).toHaveBeenCalledWith(
        'setBlobResult',
        null,
        expect.objectContaining({ blobId: expect.any(String) }),
      );
    });

    it('should handle multiple arguments', async () => {
      const { blobId } = await bs.setBlob('Test');
      const getBlobSpy = vi.spyOn(bs, 'getBlob');
      const emitSpy = vi.spyOn(socket, 'emit');
      const options = { range: { start: 0, end: 10 } };

      await bridge.callBsAndEmit('getBlob', 'getBlobResult', blobId, options);

      expect(getBlobSpy).toHaveBeenCalledWith(blobId, options);
      expect(emitSpy).toHaveBeenCalledWith(
        'getBlobResult',
        null,
        expect.objectContaining({ content: expect.any(Buffer) }),
      );
    });
  });

  describe('isConnected', () => {
    it('should return socket connection state', () => {
      expect(bridge.isConnected).toBe(false);

      socket.connect();
      expect(bridge.isConnected).toBe(true);

      socket.disconnect();
      expect(bridge.isConnected).toBe(false);
    });
  });

  describe('connection events', () => {
    it('should register connect and disconnect handlers', () => {
      const onSpy = vi.spyOn(socket, 'on');

      bridge.start();

      expect(onSpy).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith('disconnect', expect.any(Function));
    });

    it('should properly remove connect and disconnect handlers on stop', () => {
      bridge.start();
      const offSpy = vi.spyOn(socket, 'off');

      bridge.stop();

      expect(offSpy).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(offSpy).toHaveBeenCalledWith('disconnect', expect.any(Function));
    });
  });

  describe('integration with all Bs methods', () => {
    beforeEach(() => {
      bridge.start();
    });

    it('should query the injected Bs instance (PULL architecture)', async () => {
      // This test validates the fix from BUG-FIX-DOCUMENTATION-BS.md
      // Store blob in the client's local Bs
      const { blobId } = await bs.setBlob('client local content');

      let result: any;
      let error: any;

      // Simulate server querying this client via socket
      socket.emit('getBlob', blobId, (err: any, res: any) => {
        result = res;
        error = err;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // ✅ Should return blob from injected bs instance (not from any server/global Bs)
      expect(result).toBeDefined();
      expect(result.content.toString()).toBe('client local content');
      expect(error).toBeNull();
    });

    it('should only expose read operations (PULL-only architecture)', () => {
      // Verify write operations are NOT registered
      const writeOperations = ['setBlob', 'deleteBlob', 'generateSignedUrl'];

      for (const operation of writeOperations) {
        let handlerCalled = false;
        socket.emit(operation, 'test-data', () => {
          handlerCalled = true;
        });

        // Write operations should not have handlers
        expect(handlerCalled).toBe(false);
      }

      // Verify read operations ARE registered
      const readOperations = [
        'getBlob',
        'blobExists',
        'getBlobProperties',
        'listBlobs',
        'getBlobStream',
      ];

      for (const operation of readOperations) {
        const listeners = (socket as any)._listeners.get(operation);
        expect(listeners).toBeDefined();
        expect(listeners.length).toBeGreaterThan(0);
      }
    });

    it('should handle getBlob through socket', async () => {
      const { blobId } = await bs.setBlob('Get test');

      let result: any;
      let error: any;

      socket.emit('getBlob', blobId, (err: any, res: any) => {
        result = res;
        error = err;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toBeDefined();
      expect(result.content.toString()).toBe('Get test');
      expect(error).toBeNull();
    });

    it('should handle blobExists through socket', async () => {
      const { blobId } = await bs.setBlob('Exists test');

      let result: any;
      let error: any;

      socket.emit('blobExists', blobId, (err: any, res: any) => {
        result = res;
        error = err;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toBe(true);
      expect(error).toBeNull();
    });

    it('should handle getBlobProperties through socket', async () => {
      const { blobId } = await bs.setBlob('Properties test');

      let result: any;
      let error: any;

      socket.emit('getBlobProperties', blobId, (err: any, res: any) => {
        result = res;
        error = err;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toBeDefined();
      expect(result.blobId).toBe(blobId);
      expect(result.size).toBeGreaterThan(0);
      expect(error).toBeNull();
    });

    it('should handle listBlobs through socket', async () => {
      await bs.setBlob('List test 1');
      await bs.setBlob('List test 2');

      let result: any;
      let error: any;

      socket.emit('listBlobs', {}, (err: any, res: any) => {
        result = res;
        error = err;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toBeDefined();
      expect(result.blobs).toHaveLength(2);
      expect(error).toBeNull();
    });

    it('should handle getBlobStream through socket', async () => {
      const { blobId } = await bs.setBlob('Stream test');

      let result: any;
      let error: any;

      socket.emit('getBlobStream', blobId, (err: any, res: any) => {
        result = res;
        error = err;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(ReadableStream);
      expect(error).toBeNull();
    });
  });

  describe('error handling edge cases', () => {
    beforeEach(() => {
      bridge.start();
    });

    it('should handle callback not being a function', async () => {
      // Store a blob first
      const { blobId } = await bs.setBlob('Test');

      // This shouldn't throw even if callback is not provided
      expect(() => {
        socket.emit('getBlob', blobId, 'not-a-function');
      }).not.toThrow();
    });

    it('should handle empty arguments', async () => {
      let error: any;

      socket.emit('getBlob', (err: any) => {
        error = err;
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(error).toBeDefined();
    });
  });
});
