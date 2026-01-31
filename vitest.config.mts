// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/// <reference types="vitest" />

import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  return {
    test: {
      globals: true,
      environment: 'node',
      setupFiles: ['./test/setup/test-setup.ts'],
      include: ['**/test/**/*.spec.ts'],

      reporters: ['default'],
      coverage: {
        enabled: true,
        provider: 'v8', // "istanbul" or "v8"
        reporter: ['text', 'json', 'html'],
        include: ['src/**/*.ts'],
        exclude: [
          'src/index.ts',
          'src/bs.ts', // Interface definitions only
          'src/bs-test-setup.ts', // Interface definitions only
          'src/socket.ts', // Contains example code only
          'src/directional-socket-mock.ts', // Mock for testing only
        ],
        all: true,
        thresholds: {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        checkCoverage: true,
      },
    },
    define: {
      'import.meta.vitest': mode !== 'production',
    },
  };
});
