// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs } from './bs.ts';
import { Socket } from './socket.ts';

/**
 * Mock socket implementation that directly invokes Bs methods.
 * Used for testing without network layer - simulates peer connection in-process.
 */
export class PeerSocketMock implements Socket {
  private _listenersMap: Map<string | symbol, Array<(...args: any[]) => void>> =
    new Map();

  connected: boolean = false;
  disconnected: boolean = true;

  constructor(private _bs: Bs) {}

  // ............................................................................
  /**
   * Removes a specific listener for the specified event.
   * @param eventName - The event name
   * @param listener - The listener function to remove
   * @returns This socket instance for chaining
   */
  off(eventName: string | symbol, listener: (...args: any[]) => void): this {
    /* v8 ignore next -- @preserve */
    const listeners = this._listenersMap.get(eventName) || [];
    const index = listeners.indexOf(listener);
    /* v8 ignore else -- @preserve */
    if (index !== -1) {
      listeners.splice(index, 1);
      this._listenersMap.set(eventName, listeners);
    }
    return this;
  }

  // ............................................................................
  /**
   * Removes all listeners for the specified event, or all listeners if no event is specified.
   * @param eventName - Optional event name
   * @returns This socket instance for chaining
   */
  removeAllListeners(eventName?: string | symbol): this {
    if (eventName) {
      this._listenersMap.delete(eventName);
    } else {
      this._listenersMap.clear();
    }
    return this;
  }

  // ............................................................................
  /**
   * Registers an event listener for the specified event.
   * @param eventName - The event name
   * @param listener - The listener function to register
   * @returns This socket instance for chaining
   */
  on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    if (!this._listenersMap.has(eventName)) {
      this._listenersMap.set(eventName, []);
    }
    this._listenersMap.get(eventName)!.push(listener);
    return this;
  }

  // ...........................................................................
  /**
   * Simulates a connection event.
   */
  connect(): this {
    this.connected = true;
    this.disconnected = false;

    const listeners = this._listenersMap.get('connect') || [];
    for (const cb of listeners) {
      cb({});
    }
    return this;
  }

  // ...........................................................................
  /**
   * Simulates a disconnection event.
   */
  disconnect(): this {
    this.connected = false;
    this.disconnected = true;

    const listeners = this._listenersMap.get('disconnect') || [];
    for (const cb of listeners) {
      cb({});
    }
    return this;
  }

  // ...........................................................................
  /**
   * Test-facing helper that forces the `connected` flag WITHOUT firing
   * 'connect'/'disconnect' listeners. Used to simulate a dead peer: the
   * remote side stops acking (like a half-open TCP connection) while the
   * client (e.g. BsPeer.isOpen) still believes the socket is open. This
   * isolates request-timeout behavior from the fail-fast closed-socket
   * path, which only reacts to 'disconnect' events.
   * @param connected - The connected state to force
   */
  setConnected(connected: boolean): void {
    this.connected = connected;
    this.disconnected = !connected;
  }

  // ............................................................................
  /**
   * Emits an event, invoking the corresponding method on the Bs instance.
   * When `connected` is false, the emit is swallowed and the ack callback
   * is never invoked, simulating a dead peer that no longer responds.
   * @param eventName - The event name
   * @param args - Event arguments
   * @returns True if the event was handled
   */
  emit(eventName: string | symbol, ...args: unknown[]): boolean {
    if (!this.connected) {
      // Dead peer: swallow the emit, never invoke the ack callback.
      return true;
    }

    const fn = (this._bs as any)[eventName] as (
      ...args: unknown[]
    ) => Promise<unknown>;
    if (typeof fn !== 'function') {
      throw new Error(`Event ${eventName.toString()} not supported`);
    }
    const cb = args[args.length - 1] as (
      error: Error | null,
      result?: unknown,
    ) => void;
    fn.apply(this._bs, args.slice(0, -1))
      .then((result) => {
        cb(null, result);
      })
      .catch((err) => {
        cb(err);
      });

    return true;
  }
}
