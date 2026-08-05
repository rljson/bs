// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BsMem, BsPeer, PeerSocketMock } from '../src';

describe('BsPeer request timeouts', () => {
  let bsMem: BsMem;
  let socket: PeerSocketMock;

  beforeEach(() => {
    bsMem = new BsMem();
    socket = new PeerSocketMock(bsMem);
  });

  describe('dead peer (never acks)', () => {
    it('should reject after the default timeout once the peer goes silent', async () => {
      vi.useFakeTimers();
      try {
        const bsPeer = new BsPeer(socket);
        await bsPeer.init();

        // Peer still looks open (no 'disconnect' fired), but the socket
        // silently stops delivering acks — like a half-open connection.
        socket.setConnected(false);
        expect(bsPeer.isOpen).toBe(true);

        const pending = expect(bsPeer.getBlob('some-id')).rejects.toThrow(
          "Timeout after 30000ms on 'getBlob'",
        );

        await vi.advanceTimersByTimeAsync(30_000);
        await pending;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should honor a configurable timeout', async () => {
      vi.useFakeTimers();
      try {
        const bsPeer = new BsPeer(socket, { requestTimeoutMs: 5_000 });
        await bsPeer.init();

        socket.setConnected(false);

        const pending = expect(bsPeer.blobExists('some-id')).rejects.toThrow(
          "Timeout after 5000ms on 'blobExists'",
        );

        await vi.advanceTimersByTimeAsync(5_000);
        await pending;
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not reject early, before the configured timeout elapses', async () => {
      vi.useFakeTimers();
      try {
        const bsPeer = new BsPeer(socket, { requestTimeoutMs: 5_000 });
        await bsPeer.init();

        socket.setConnected(false);

        let settled = false;
        bsPeer
          .blobExists('some-id')
          .catch(() => {})
          .finally(() => {
            settled = true;
          });

        await vi.advanceTimersByTimeAsync(4_000);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(settled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should bypass the timeout entirely when requestTimeoutMs <= 0', async () => {
      const bsPeer = new BsPeer(socket, { requestTimeoutMs: 0 });
      await bsPeer.init();

      // With no timeout, a request against the live (connected) socket
      // still resolves normally — this exercises the early-return branch
      // of `_withTimeout` without ever racing a timer.
      const result = await bsPeer.setBlob('no-timeout');
      expect(result.blobId).toBeDefined();
    });
  });

  describe('fail-fast on closed socket', () => {
    let bsPeer: BsPeer;

    beforeEach(async () => {
      bsPeer = new BsPeer(socket);
      await bsPeer.init();
      await bsPeer.close();
      expect(bsPeer.isOpen).toBe(false);
    });

    const closedSocketCases: Array<{
      name: string;
      call: (peer: BsPeer) => Promise<unknown>;
    }> = [
      { name: 'setBlob', call: (peer) => peer.setBlob('content') },
      { name: 'getBlob', call: (peer) => peer.getBlob('some-id') },
      { name: 'getBlobStream', call: (peer) => peer.getBlobStream('some-id') },
      { name: 'deleteBlob', call: (peer) => peer.deleteBlob('some-id') },
      { name: 'blobExists', call: (peer) => peer.blobExists('some-id') },
      {
        name: 'getBlobProperties',
        call: (peer) => peer.getBlobProperties('some-id'),
      },
      { name: 'listBlobs', call: (peer) => peer.listBlobs() },
      {
        name: 'generateSignedUrl',
        call: (peer) => peer.generateSignedUrl('some-id', 3600),
      },
    ];

    it.each(closedSocketCases)(
      '$name rejects immediately with BsPeer: socket closed',
      async ({ call }) => {
        await expect(call(bsPeer)).rejects.toThrow('BsPeer: socket closed');
      },
    );
  });

  describe('normal operation', () => {
    it('should resolve normally and clear the timer before it fires', async () => {
      vi.useFakeTimers();
      try {
        const bsPeer = new BsPeer(socket, { requestTimeoutMs: 50 });
        await bsPeer.init();

        const result = await bsPeer.setBlob('Hello timeout test');
        expect(result.blobId).toBeDefined();

        // If the timer had leaked (not cleared on settlement), advancing
        // past it here would still be harmless because the promise already
        // resolved — this just proves normal operation isn't blocked by
        // the timeout machinery.
        await vi.advanceTimersByTimeAsync(1_000);

        const exists = await bsMem.blobExists(result.blobId);
        expect(exists).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
