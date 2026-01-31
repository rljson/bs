// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import type { Bs } from './bs.js';
import type { Socket } from './socket.js';

/**
 * Bridges Socket events to Bs method calls.
 *
 * This class listens to socket events and translates them into corresponding
 * Bs method calls, automatically registering all Bs interface methods.
 */
export class BsPeerBridge {
  private _eventHandlers: Map<string | symbol, (...args: any[]) => void> =
    new Map();
  private _handleConnectBound = this._handleConnect.bind(this);
  private _handleDisconnectBound = this._handleDisconnect.bind(this);

  constructor(
    private _bs: Bs,
    private _socket: Socket,
  ) {}

  /**
   * Starts the bridge by setting up connection event handlers and
   * automatically registering all Bs methods.
   */
  start(): void {
    this._socket.on('connect', this._handleConnectBound);
    this._socket.on('disconnect', this._handleDisconnectBound);

    // Automatically register all Bs interface methods
    this._registerBsMethods();
  }

  /**
   * Stops the bridge by removing all event handlers.
   */
  stop(): void {
    this._socket.off('connect', this._handleConnectBound);
    this._socket.off('disconnect', this._handleDisconnectBound);

    for (const [eventName, handler] of this._eventHandlers) {
      this._socket.off(eventName, handler);
    }
    this._eventHandlers.clear();
  }

  /**
   * Automatically registers all Bs interface methods as socket event handlers.
   */
  private _registerBsMethods(): void {
    // Core Bs interface methods (read-only for PULL architecture)
    // Only register read operations to match IoPeerBridge pattern
    const bsMethods = [
      'getBlob',
      'getBlobStream',
      'blobExists',
      'getBlobProperties',
      'listBlobs',
    ];

    for (const methodName of bsMethods) {
      this.registerEvent(methodName);
    }
  }

  /**
   * Registers a socket event to be translated to a Bs method call.
   * @param eventName - The socket event name (should match a Bs method name)
   * @param bsMethodName - (Optional) The Bs method name if different from eventName
   */
  registerEvent(eventName: string, bsMethodName?: string): void {
    const methodName = bsMethodName || eventName;

    /* v8 ignore next -- @preserve */
    const handler = (...args: any[]) => {
      // The last argument is expected to be a callback function
      const callback = args[args.length - 1];
      const methodArgs = args.slice(0, -1);

      // Get the Bs method
      const bsMethod = (this._bs as any)[methodName];

      /* v8 ignore next -- @preserve */
      if (typeof bsMethod !== 'function') {
        const error = new Error(
          `Method "${methodName}" not found on Bs instance`,
        );
        if (typeof callback === 'function') {
          callback(error, null);
        }
        return;
      }

      // Call the Bs method and handle the response
      /* v8 ignore next -- @preserve */
      bsMethod
        .apply(this._bs, methodArgs)
        .then((result: any) => {
          if (typeof callback === 'function') {
            // Node.js style: error-first callback (error, result)
            callback(null, result); // Two arguments
          }
        })
        .catch((error: any) => {
          if (typeof callback === 'function') {
            // Node.js style: error-first callback (error, result)
            callback(error, null); // Two arguments
          }
        });
    };

    this._eventHandlers.set(eventName, handler);
    this._socket.on(eventName, handler);
  }

  /**
   * Registers multiple socket events at once.
   * @param eventNames - Array of event names to register
   */
  registerEvents(eventNames: string[]): void {
    for (const eventName of eventNames) {
      this.registerEvent(eventName);
    }
  }

  /**
   * Unregisters a socket event handler.
   * @param eventName - The event name to unregister
   */
  unregisterEvent(eventName: string | symbol): void {
    const handler = this._eventHandlers.get(eventName);
    if (handler) {
      this._socket.off(eventName, handler);
      this._eventHandlers.delete(eventName);
    }
  }

  /**
   * Emits a result back through the socket.
   * @param eventName - The event name to emit
   * @param data - The data to send
   */
  emitToSocket(eventName: string | symbol, ...data: any[]): void {
    this._socket.emit(eventName, ...data);
  }

  /**
   * Calls a Bs method directly and emits the result through the socket.
   * @param bsMethodName - The Bs method to call
   * @param socketEventName - The socket event to emit with the result
   * @param args - Arguments to pass to the Bs method
   */
  async callBsAndEmit(
    bsMethodName: string,
    socketEventName: string | symbol,
    ...args: any[]
  ): Promise<void> {
    try {
      const bsMethod = (this._bs as any)[bsMethodName];

      if (typeof bsMethod !== 'function') {
        throw new Error(`Method "${bsMethodName}" not found on Bs instance`);
      }

      const result = await bsMethod.apply(this._bs, args);
      this._socket.emit(socketEventName, null, result);
    } catch (error) {
      this._socket.emit(socketEventName, error, null);
    }
  }

  /* v8 ignore next -- @preserve */
  private _handleConnect(): void {
    // Override this method in subclasses to handle connection events
  }

  /* v8 ignore next -- @preserve */
  private _handleDisconnect(): void {
    // Override this method in subclasses to handle disconnection events
  }

  /**
   * Gets the current socket instance.
   */
  get socket(): Socket {
    return this._socket;
  }

  /**
   * Gets the current Bs instance.
   */
  get bs(): Bs {
    return this._bs;
  }

  /**
   * Returns whether the socket is currently connected.
   */
  get isConnected(): boolean {
    return this._socket.connected;
  }
}
