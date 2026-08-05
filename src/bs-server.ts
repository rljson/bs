// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, DownloadBlobOptions, ListBlobsOptions } from './bs.ts';
import { Socket } from './socket.ts';

/**
 * Server implementation that exposes a Bs instance over socket connections.
 * Allows multiple clients to access the same blob storage instance remotely.
 */
export class BsServer {
  private _sockets: Socket[] = [];

  /**
   * The CRUD listeners registered on each socket in `_addTransportLayer`,
   * retained by reference so `removeSocket` can actually `socket.off()`
   * them. Without this, the listeners are anonymous arrows with no retained
   * reference, so nothing could ever unregister them — `removeSocket` used
   * to only forget the socket internally while the blob CRUD listeners kept
   * firing on it forever (a leak, and — when several BsServers share one
   * socket — duplicate execution of every blob request).
   */
  private _socketHandlers: Map<
    Socket,
    Array<{ event: string; handler: (...args: unknown[]) => void }>
  > = new Map();

  constructor(private _bs: Bs) {}

  // ...........................................................................
  /**
   * Adds a socket to the BsServer instance.
   * @param socket - The socket to add.
   */
  async addSocket(socket: Socket): Promise<void> {
    // Add transport layer to the socket
    await this._addTransportLayer(socket);

    // Add socket to the list of sockets
    this._sockets.push(socket);
  }

  // ...........................................................................
  /**
   * Removes a socket from the BsServer instance, unregistering its CRUD
   * listeners so it no longer reacts to blob events. Idempotent: removing a
   * socket twice, or a socket that was never added, is a no-op — it does not
   * throw.
   * @param socket - The socket to remove.
   */
  removeSocket(socket: Socket): void {
    const handlers = this._socketHandlers.get(socket);
    if (handlers) {
      for (const { event, handler } of handlers) {
        socket.off(event, handler);
      }
      this._socketHandlers.delete(socket);
    }

    this._sockets = this._sockets.filter((s) => s !== socket);
  }

  // ...........................................................................
  /**
   * Adds a transport layer to the given socket.
   * @param socket - The socket to add the transport layer to.
   */
  private async _addTransportLayer(socket: Socket): Promise<void> {
    const crud = this._generateTransportLayerCRUD();
    const handlers: Array<{
      event: string;
      handler: (...args: unknown[]) => void;
    }> = [];

    for (const [key, fn] of Object.entries(crud)) {
      const handler = (...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          error: Error | null,
          result?: unknown,
        ) => void;

        fn.apply(this, args.slice(0, -1))
          .then((result) => {
            cb(null, result);
          })
          .catch((err) => {
            cb(err);
          });
      };

      socket.on(key, handler);
      handlers.push({ event: key, handler });
    }

    this._socketHandlers.set(socket, handlers);
  }

  // ...........................................................................
  /**
   * Generates a transport layer object that always delegates to the current
   * this._bs. Each method is an arrow function reading this._bs at call
   * time so that external code can replace _bs after construction and all
   * existing socket handlers pick up the new instance.
   */
  private _generateTransportLayerCRUD = () =>
    ({
      setBlob: (content: Buffer | string | ReadableStream) =>
        this._bs.setBlob(content),
      getBlob: (blobId: string, options?: DownloadBlobOptions) =>
        this._bs.getBlob(blobId, options),
      getBlobStream: (blobId: string) => this._bs.getBlobStream(blobId),
      deleteBlob: (blobId: string) => this._bs.deleteBlob(blobId),
      blobExists: (blobId: string) => this._bs.blobExists(blobId),
      getBlobProperties: (blobId: string) =>
        this._bs.getBlobProperties(blobId),
      listBlobs: (options?: ListBlobsOptions) => this._bs.listBlobs(options),
      generateSignedUrl: (
        blobId: string,
        expiresIn: number,
        permissions?: 'read' | 'delete',
      ) => this._bs.generateSignedUrl(blobId, expiresIn, permissions),
    } as { [key: string]: (...args: unknown[]) => Promise<unknown> });
}
