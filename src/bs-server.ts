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

  constructor(private readonly _bs: Bs) {}

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
    const methods = this._generateTransportLayer(this._bs);
    for (const [key, fn] of Object.entries(methods)) {
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
   * Generates a transport layer object for the given Bs instance.
   * @param bs - The Bs instance to generate the transport layer for.
   * @returns An object containing methods that correspond to the Bs interface.
   */
  private _generateTransportLayer = (bs: Bs) =>
    ({
      setBlob: (content: Buffer | string | ReadableStream) =>
        bs.setBlob(content),
      getBlob: (blobId: string, options?: DownloadBlobOptions) =>
        bs.getBlob(blobId, options),
      getBlobStream: (blobId: string) => bs.getBlobStream(blobId),
      deleteBlob: (blobId: string) => bs.deleteBlob(blobId),
      blobExists: (blobId: string) => bs.blobExists(blobId),
      getBlobProperties: (blobId: string) => bs.getBlobProperties(blobId),
      listBlobs: (options?: ListBlobsOptions) => bs.listBlobs(options),
      generateSignedUrl: (
        blobId: string,
        expiresIn: number,
        permissions?: 'read' | 'delete',
      ) => bs.generateSignedUrl(blobId, expiresIn, permissions),
    } as { [key: string]: (...args: unknown[]) => Promise<unknown> });
}
