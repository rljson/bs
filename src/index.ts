// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// Blob Storage
export { BsMem } from './bs-mem.js';
export {
  BLOB_SOURCE_TIMEOUT_MS,
  BsMulti,
  SLOW_SOURCE_MEMORY_MS,
  type BsMultiBs,
} from './bs-multi.js';
export { BsPeerBridge } from './bs-peer-bridge.js';
export { BsPeer } from './bs-peer.js';
export { BsServer } from './bs-server.js';
export type { BsTestSetup } from './bs-test-setup.js';
export {
  BLOCK_AVG_BYTES,
  BLOCK_MAX_BYTES,
  BLOCK_MIN_BYTES,
  ContentId,
  blockEnd,
  forEachBlock,
  readBlocks,
  streamBlocks,
  verifyBlob,
  verifyBlock,
  writeBlocks,
  type BlobLayout,
  type PutBlock,
  type ReadBlock,
} from './blob-blocks.js';
export type {
  BlobBlock,
  BlobProperties,
  Bs,
  DownloadBlobOptions,
  ListBlobsOptions,
  ListBlobsResult,
} from './bs.js';

// Socket abstractions
export { PeerSocketMock } from './peer-socket-mock.js';
export { SocketMock } from './socket-mock.js';
export { createSocketPair } from './directional-socket-mock.js';
export type { Socket } from './socket.js';
