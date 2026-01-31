// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from './socket.ts';

/**
 * Creates a pair of connected sockets that properly route messages between them.
 * Unlike SocketMock, this maintains directionality - when socketA emits, only socketB's
 * listeners fire, not socketA's own listeners.
 *
 * This is essential for client-server testing where both use the same socket instance
 * but need separate event handling.
 */
export function createSocketPair(): [Socket, Socket] {
  const socketA = new DirectionalSocketMock();
  const socketB = new DirectionalSocketMock();

  // Connect them bidirectionally
  socketA._setPeer(socketB);
  socketB._setPeer(socketA);

  return [socketA, socketB];
}

class DirectionalSocketMock implements Socket {
  public connected: boolean = false;
  public disconnected: boolean = true;

  private _peer?: DirectionalSocketMock;
  private _listeners: Map<string | symbol, Array<(...args: any[]) => void>> =
    new Map();
  private _onceListeners: Map<
    string | symbol,
    Array<(...args: any[]) => void>
  > = new Map();

  _setPeer(peer: DirectionalSocketMock): void {
    this._peer = peer;
  }

  connect(): void {
    if (!this.connected) {
      this.connected = true;
      this.disconnected = false;
      // Trigger local 'connect' event
      this._triggerLocal('connect');
      // Trigger peer's 'connect' event
      if (this._peer) {
        this._peer._triggerLocal('connect');
      }
    }
  }

  disconnect(): void {
    if (this.connected) {
      this.connected = false;
      this.disconnected = true;
      this._triggerLocal('disconnect');
      if (this._peer) {
        this._peer._triggerLocal('disconnect');
      }
    }
  }

  on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, []);
    }
    this._listeners.get(eventName)!.push(listener);
    return this;
  }

  once(eventName: string | symbol, listener: (...args: any[]) => void): this {
    if (!this._onceListeners.has(eventName)) {
      this._onceListeners.set(eventName, []);
    }
    this._onceListeners.get(eventName)!.push(listener);
    return this;
  }

  off(eventName: string | symbol, listener?: (...args: any[]) => void): this {
    if (listener) {
      const regularListeners = this._listeners.get(eventName);
      if (regularListeners) {
        const index = regularListeners.indexOf(listener);
        if (index > -1) regularListeners.splice(index, 1);
      }
      const onceListeners = this._onceListeners.get(eventName);
      if (onceListeners) {
        const index = onceListeners.indexOf(listener);
        if (index > -1) onceListeners.splice(index, 1);
      }
    } else {
      this._listeners.delete(eventName);
      this._onceListeners.delete(eventName);
    }
    return this;
  }

  /**
   * Emits an event to the PEER socket (cross-socket emission).
   * This is the key difference from SocketMock - emit() sends to the other side,
   * not to local listeners.
   *
   * Implements Socket.IO acknowledgement pattern: the last argument can be a callback
   * that the peer will invoke to send a response back.
   * @param eventName - The event name to emit
   * @param args - Arguments to pass with the event
   */
  emit(eventName: string | symbol, ...args: any[]): boolean {
    if (!this._peer) {
      console.warn(
        `DirectionalSocketMock.emit: No peer connected for event ${String(eventName)}`,
      );
      return false;
    }

    // Trigger the event on the PEER socket, not locally
    this._peer._triggerLocal(eventName, ...args);
    return true;
  }

  /**
   * Triggers listeners on THIS socket (local emission).
   * Used internally when receiving events from peer.
   * @param eventName - The event name to trigger
   * @param args - Arguments to pass to the listeners
   */
  private _triggerLocal(eventName: string | symbol, ...args: any[]): void {
    // Trigger regular listeners
    const regularListeners = this._listeners.get(eventName);
    if (regularListeners) {
      [...regularListeners].forEach((listener) => {
        try {
          listener(...args);
        } catch (error) {
          console.error(`Error in listener for ${String(eventName)}:`, error);
        }
      });
    }

    // Trigger and remove once listeners
    const onceListeners = this._onceListeners.get(eventName);
    if (onceListeners) {
      const listenersToCall = [...onceListeners];
      this._onceListeners.delete(eventName);
      listenersToCall.forEach((listener) => {
        try {
          listener(...args);
        } catch (error) {
          console.error(
            `Error in once listener for ${String(eventName)}:`,
            error,
          );
        }
      });
    }
  }

  removeAllListeners(eventName?: string | symbol): this {
    if (eventName !== undefined) {
      this._listeners.delete(eventName);
      this._onceListeners.delete(eventName);
    } else {
      this._listeners.clear();
      this._onceListeners.clear();
    }
    return this;
  }

  listenerCount(eventName: string | symbol): number {
    const regularCount = this._listeners.get(eventName)?.length || 0;
    const onceCount = this._onceListeners.get(eventName)?.length || 0;
    return regularCount + onceCount;
  }

  listeners(eventName: string | symbol): Array<(...args: any[]) => void> {
    const regularListeners = this._listeners.get(eventName) || [];
    const onceListeners = this._onceListeners.get(eventName) || [];
    return [...regularListeners, ...onceListeners];
  }

  eventNames(): Array<string | symbol> {
    const allEvents = new Set([
      ...this._listeners.keys(),
      ...this._onceListeners.keys(),
    ]);
    return Array.from(allEvents);
  }
}
