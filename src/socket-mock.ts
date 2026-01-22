// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/* v8 ignore file -- @preserve */
import { Socket } from './socket.ts';

/**
 * Mock implementation of Socket for testing purposes.
 * Provides full event emitter functionality without network communication.
 */
export class SocketMock implements Socket {
  public connected: boolean = false;
  public disconnected: boolean = true;

  private _listeners: Map<string | symbol, Array<(...args: any[]) => void>> =
    new Map();
  private _onceListeners: Map<
    string | symbol,
    Array<(...args: any[]) => void>
  > = new Map();

  connect(): void {
    if (!this.connected) {
      this.connected = true;
      this.disconnected = false;
      this.emit('connect');
    }
  }

  disconnect(): void {
    if (this.connected) {
      this.connected = false;
      this.disconnected = true;
      this.emit('disconnect');
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
      // Remove specific listener
      const regularListeners = this._listeners.get(eventName);
      if (regularListeners) {
        const index = regularListeners.indexOf(listener);
        if (index > -1) {
          regularListeners.splice(index, 1);
        }
      }

      const onceListeners = this._onceListeners.get(eventName);
      if (onceListeners) {
        const index = onceListeners.indexOf(listener);
        if (index > -1) {
          onceListeners.splice(index, 1);
        }
      }
    } else {
      // Remove all listeners for the event
      this._listeners.delete(eventName);
      this._onceListeners.delete(eventName);
    }
    return this;
  }

  emit(eventName: string | symbol, ...args: any[]): boolean {
    let hasListeners = false;

    // Emit to regular listeners
    const regularListeners = this._listeners.get(eventName);
    if (regularListeners && regularListeners.length > 0) {
      hasListeners = true;
      // Create a copy to avoid issues if listeners are removed during emission
      [...regularListeners].forEach((listener) => {
        try {
          listener(...args);
        } catch (error) {
          console.error(
            `Error in listener for event ${String(eventName)}:`,
            error,
          );
        }
      });
    }

    // Emit to once listeners and remove them
    const onceListeners = this._onceListeners.get(eventName);
    if (onceListeners && onceListeners.length > 0) {
      hasListeners = true;
      // Create a copy and clear the original array
      const listenersToCall = [...onceListeners];
      this._onceListeners.delete(eventName);

      listenersToCall.forEach((listener) => {
        try {
          listener(...args);
        } catch (error) {
          console.error(
            `Error in once listener for event ${String(eventName)}:`,
            error,
          );
        }
      });
    }

    return hasListeners;
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

  // Test helper methods
  reset(): void {
    this.connected = false;
    this.disconnected = true;
    this.removeAllListeners();
  }

  simulateError(error: Error): void {
    this.emit('error', error);
  }

  simulateMessage(message: any): void {
    this.emit('message', message);
  }

  // Get internal state for testing
  getListeners(): Map<string | symbol, Array<(...args: any[]) => void>> {
    return new Map(this._listeners);
  }

  getOnceListeners(): Map<string | symbol, Array<(...args: any[]) => void>> {
    return new Map(this._onceListeners);
  }
}
