// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, vi } from 'vitest';

import { SocketMock } from '../src';

describe('SocketMock', () => {
  describe('connection lifecycle', () => {
    it('should start disconnected', () => {
      const socket = new SocketMock();
      expect(socket.connected).toBe(false);
      expect(socket.disconnected).toBe(true);
    });

    it('should connect and emit connect event', () => {
      const socket = new SocketMock();
      let connectFired = false;
      socket.on('connect', () => {
        connectFired = true;
      });

      socket.connect();

      expect(socket.connected).toBe(true);
      expect(socket.disconnected).toBe(false);
      expect(connectFired).toBe(true);
    });

    it('should disconnect and emit disconnect event', () => {
      const socket = new SocketMock();
      let disconnectFired = false;
      socket.on('disconnect', () => {
        disconnectFired = true;
      });

      socket.connect();
      socket.disconnect();

      expect(socket.connected).toBe(false);
      expect(socket.disconnected).toBe(true);
      expect(disconnectFired).toBe(true);
    });

    it('should not connect twice', () => {
      const socket = new SocketMock();
      let connectCount = 0;
      socket.on('connect', () => {
        connectCount++;
      });

      socket.connect();
      socket.connect(); // Second call should do nothing

      expect(connectCount).toBe(1);
    });

    it('should not disconnect twice', () => {
      const socket = new SocketMock();
      let disconnectCount = 0;
      socket.on('disconnect', () => {
        disconnectCount++;
      });

      socket.connect();
      socket.disconnect();
      socket.disconnect(); // Second call should do nothing

      expect(disconnectCount).toBe(1);
    });
  });

  describe('event listeners', () => {
    it('should register and emit events', () => {
      const socket = new SocketMock();
      let eventFired = false;
      let eventData: string | undefined;

      socket.on('test-event', (data: string) => {
        eventFired = true;
        eventData = data;
      });

      socket.emit('test-event', 'test-data');

      expect(eventFired).toBe(true);
      expect(eventData).toBe('test-data');
    });

    it('should support multiple listeners for same event', () => {
      const socket = new SocketMock();
      const results: string[] = [];

      socket.on('test', (data: string) => results.push(`1:${data}`));
      socket.on('test', (data: string) => results.push(`2:${data}`));
      socket.on('test', (data: string) => results.push(`3:${data}`));

      socket.emit('test', 'hello');

      expect(results).toEqual(['1:hello', '2:hello', '3:hello']);
    });

    it('should support once listeners', () => {
      const socket = new SocketMock();
      let count = 0;

      socket.once('test', () => {
        count++;
      });

      socket.emit('test');
      socket.emit('test');
      socket.emit('test');

      expect(count).toBe(1);
    });

    it('should remove specific listener with off', () => {
      const socket = new SocketMock();
      let count = 0;
      const listener = () => {
        count++;
      };

      socket.on('test', listener);
      socket.emit('test');
      expect(count).toBe(1);

      socket.off('test', listener);
      socket.emit('test');
      expect(count).toBe(1); // Should not increase
    });

    it('should remove all listeners for event', () => {
      const socket = new SocketMock();
      let count1 = 0;
      let count2 = 0;

      socket.on('test', () => count1++);
      socket.on('test', () => count2++);

      socket.emit('test');
      expect(count1).toBe(1);
      expect(count2).toBe(1);

      socket.off('test');
      socket.emit('test');
      expect(count1).toBe(1); // Should not increase
      expect(count2).toBe(1); // Should not increase
    });

    it('should remove all listeners with removeAllListeners', () => {
      const socket = new SocketMock();
      let count1 = 0;
      let count2 = 0;

      socket.on('event1', () => count1++);
      socket.on('event2', () => count2++);

      socket.removeAllListeners();

      socket.emit('event1');
      socket.emit('event2');

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });

    it('should remove all listeners for specific event', () => {
      const socket = new SocketMock();
      let count1 = 0;
      let count2 = 0;

      socket.on('event1', () => count1++);
      socket.on('event2', () => count2++);

      socket.removeAllListeners('event1');

      socket.emit('event1');
      socket.emit('event2');

      expect(count1).toBe(0);
      expect(count2).toBe(1);
    });

    it('should return correct listener count', () => {
      const socket = new SocketMock();

      socket.on('test', () => {});
      socket.on('test', () => {});
      socket.once('test', () => {});

      expect(socket.listenerCount('test')).toBe(3);
    });

    it('should return all listeners', () => {
      const socket = new SocketMock();
      const fn1 = () => {};
      const fn2 = () => {};

      socket.on('test', fn1);
      socket.once('test', fn2);

      const listeners = socket.listeners('test');
      expect(listeners).toHaveLength(2);
      expect(listeners).toContain(fn1);
      expect(listeners).toContain(fn2);
    });

    it('should return all event names', () => {
      const socket = new SocketMock();

      socket.on('event1', () => {});
      socket.on('event2', () => {});
      socket.once('event3', () => {});

      const names = socket.eventNames();
      expect(names).toHaveLength(3);
      expect(names).toContain('event1');
      expect(names).toContain('event2');
      expect(names).toContain('event3');
    });
  });

  describe('test helpers', () => {
    it('should reset to initial state', () => {
      const socket = new SocketMock();
      let count = 0;

      socket.on('test', () => count++);
      socket.connect();
      socket.emit('test');

      expect(socket.connected).toBe(true);
      expect(count).toBe(1);

      socket.reset();

      expect(socket.connected).toBe(false);
      expect(socket.disconnected).toBe(true);
      socket.emit('test');
      expect(count).toBe(1); // Listener removed
    });

    it('should simulate errors', () => {
      const socket = new SocketMock();
      let errorCaught: Error | undefined;

      socket.on('error', (err: Error) => {
        errorCaught = err;
      });

      const testError = new Error('Test error');
      socket.simulateError(testError);

      expect(errorCaught).toBe(testError);
    });

    it('should simulate messages', () => {
      const socket = new SocketMock();
      let messageCaught: string | undefined;

      socket.on('message', (msg: string) => {
        messageCaught = msg;
      });

      socket.simulateMessage('test message');

      expect(messageCaught).toBe('test message');
    });

    it('should get listeners map', () => {
      const socket = new SocketMock();
      const fn = () => {};

      socket.on('test', fn);

      const listeners = socket.getListeners();
      expect(listeners.get('test')).toContain(fn);
    });

    it('should get once listeners map', () => {
      const socket = new SocketMock();
      const fn = () => {};

      socket.once('test', fn);

      const listeners = socket.getOnceListeners();
      expect(listeners.get('test')).toContain(fn);
    });
  });

  describe('error handling in listeners', () => {
    it('should catch errors in regular listeners', () => {
      const socket = new SocketMock();
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      socket.on('test', () => {
        throw new Error('Listener error');
      });

      expect(() => socket.emit('test')).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should catch errors in once listeners', () => {
      const socket = new SocketMock();
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      socket.once('test', () => {
        throw new Error('Once listener error');
      });

      expect(() => socket.emit('test')).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('chaining', () => {
    it('should support method chaining', () => {
      const socket = new SocketMock();
      let count = 0;

      const result = socket
        .on('test', () => count++)
        .on('test', () => count++)
        .removeAllListeners('other');

      expect(result).toBe(socket);
    });
  });
});
