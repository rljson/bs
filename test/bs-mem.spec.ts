// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { beforeEach, describe, expect, it } from 'vitest';

import { BsMem } from '../src/bs-mem';

/**
 * BsMem-specific tests.
 * Standard Bs interface functionality is tested in bs-conformance.spec.ts
 * These tests cover BsMem-specific features like clear() and size property.
 */
describe('BsMem - Implementation Specific', () => {
  let storage: BsMem;

  beforeEach(() => {
    storage = new BsMem();
  });

  describe('clear()', () => {
    it('should remove all blobs', async () => {
      await storage.setBlob('Blob 1');
      await storage.setBlob('Blob 2');
      await storage.setBlob('Blob 3');

      expect(storage.size).toBe(3);

      storage.clear();

      expect(storage.size).toBe(0);
      const result = await storage.listBlobs();
      expect(result.blobs).toEqual([]);
    });

    it('should allow adding blobs after clear', async () => {
      await storage.setBlob('Before clear');
      storage.clear();

      const result = await storage.setBlob('After clear');
      expect(result.blobId).toBeDefined();
      expect(storage.size).toBe(1);
    });
  });

  describe('size', () => {
    it('should return 0 for empty storage', () => {
      expect(storage.size).toBe(0);
    });

    it('should return correct count of blobs', async () => {
      await storage.setBlob('Blob 1');
      expect(storage.size).toBe(1);

      await storage.setBlob('Blob 2');
      expect(storage.size).toBe(2);

      await storage.setBlob('Blob 3');
      expect(storage.size).toBe(3);
    });

    it('should not count duplicates', async () => {
      const content = Buffer.from('Same content');

      await storage.setBlob(content);
      await storage.setBlob(content);
      await storage.setBlob(content);

      expect(storage.size).toBe(1);
    });

    it('should decrease after deletion', async () => {
      const { blobId } = await storage.setBlob('Delete me');
      expect(storage.size).toBe(1);

      await storage.deleteBlob(blobId);
      expect(storage.size).toBe(0);
    });
  });
});
