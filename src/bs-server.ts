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
   * Removes a socket from the BsServer instance.
   * @param socket - The socket to remove.
   */
  removeSocket(socket: Socket): void {
    this._sockets = this._sockets.filter((s) => s !== socket);
  }

  // ...........................................................................
  /**
   * Adds a transport layer to the given socket.
   * @param socket - The socket to add the transport layer to.
   */
  private async _addTransportLayer(socket: Socket): Promise<void> {
    const crud = this._generateTransportLayerCRUD();
    for (const [key, fn] of Object.entries(crud)) {
      socket.on(key, (...args: unknown[]) => {
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
      });
    }
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
