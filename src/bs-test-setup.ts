// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs } from './bs.js';

/**
 * Bs implementation need to implement this interface to be used in
 * conformance tests.
 */
export interface BsTestSetup {
  /** Setup before all tests */
  beforeAll: () => Promise<void>;

  /**
   * Initializes the Bs implementation.
   * Should create a fresh instance for each test.
   */
  beforeEach: () => Promise<void>;

  /**
   * Tears down the Bs implementation.
   * Should clean up resources after each test.
   */
  afterEach: () => Promise<void>;

  /** Cleanup after all tests */
  afterAll: () => Promise<void>;

  /**
   * The Bs implementation to be used in the conformance tests.
   */
  bs: Bs;
}
