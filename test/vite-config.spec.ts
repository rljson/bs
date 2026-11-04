// @license
// Copyright (c) 2026 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../vite.config.mts';

/** Every module `src` imports at runtime from `node:`. */
const nodeImports = (): string[] => {
  const found = new Set<string>();
  for (const file of readdirSync('src').filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join('src', file), 'utf8');
    for (const [, kind, name] of text.matchAll(
      /import\s+(type\s+)?[^;]*?from\s+'(node:[^']+)'/g,
    )) {
      if (!kind) found.add(name!);
    }
  }
  return [...found].sort();
};

describe('the build', () => {
  it('keeps every Node builtin the sources import out of the bundle', () => {
    // The tests run against the sources, the package ships the build: a
    // builtin missing here is replaced by an empty browser shim, and only the
    // published package fails.
    const external = config.build!.rollupOptions!.external as Array<
      string | RegExp
    >;
    const isExternal = (id: string) =>
      external.some((e) => (typeof e === 'string' ? e === id : e.test(id)));

    const imports = nodeImports();
    expect(imports).toContain('node:crypto');
    expect(imports.filter((id) => !isExternal(id))).toEqual([]);
  });
});
