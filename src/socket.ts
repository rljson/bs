// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/**
 * Interface for a generic Socket, similar to Node.js EventEmitter.
 * This abstraction allows different transport implementations (WebSocket, Socket.IO, etc.)
 */
export interface Socket {
  connected: boolean;
  disconnected: boolean;
  connect(): void;
  disconnect(): void;
  on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  emit(eventName: string | symbol, ...args: any[]): boolean | this;
  off(eventName: string | symbol, listener: (...args: any[]) => void): this;
  removeAllListeners(eventName?: string | symbol): this;
}

export const socketExample = (): Socket => ({
  connected: false,
  disconnected: true,
  connect() {
    this.connected = true;
    this.disconnected = false;
    this.emit('connect');
  },
  disconnect() {
    this.connected = false;
    this.disconnected = true;
    this.emit('disconnect');
  },
  /* v8 ignore next -- @preserve */
  on() {
    return this;
  },
  /* v8 ignore next -- @preserve */
  emit() {
    return true;
  },
  /* v8 ignore next -- @preserve */
  off() {
    return this;
  },
  /* v8 ignore next -- @preserve */
  removeAllListeners() {
    return this;
  },
});
