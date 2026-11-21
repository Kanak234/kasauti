/* =============================================================================
 * KASAUTI — test/schema.test.ts   (v2.1 Code Map)
 * WHAT:  Import resolution per language, graph shape, crawl order.
 * WHY:   A wrong import edge draws a dependency that does not exist — the map
 *        would lie. Unresolvable imports must simply be absent.
 * ========================================================================== */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, crawlOrder, resolveImports } from '../webview/schemaGraph';
import { extractImportSpecs } from '../src/engine/imports';
import type { UiFile } from '../src/snapshot';

const f = (path: string, lang: string, imp?: string[], extra: Partial<UiFile> = {}): UiFile => ({
  key: 'k:' + path, path, lang, tier: 1, grade: 'A', score: 100, sloc: 20, debt: 0, maxCC: 1, maxCog: 0, dupLines: 0,
  counts: { critical: 0, major: 0, minor: 0, info: 0 }, imp, ...extra });

test('imports: specifiers are extracted per language', () => {
  assert.deepEqual(extractImportSpecs('python', 'import os, app.db as d\nfrom .utils import x\nfrom ..core.models import M\n'), ['.utils', '..core.models', 'os', 'app.db']);
  assert.deepEqual(extractImportSpecs('typescript', "import a from './a';\nconst b = require('../b');\nimport('lodash');\n"), ['./a', '../b', 'lodash']);
  assert.deepEqual(extractImportSpecs('java', 'import com.acme.util.Strings;\nimport static java.lang.Math.max;\n'), ['com.acme.util.Strings', 'java.lang.Math.max']);
  assert.deepEqual(extractImportSpecs('cpp', '#include <vector>\n#include "geo/point.h"\n'), ['geo/point.h']);
});

test('resolve: only real project files become edges', () => {
  const files = [
    f('app/main.py', 'Python', ['.db', 'app.utils', 'os', 'requests']),
    f('app/db.py', 'Python'), f('app/utils.py', 'Python'),
    f('web/index.ts', 'TypeScript', ['./api', '../app/none', 'react']), f('web/api/index.ts', 'TypeScript'),
    f('src/main/java/com/acme/App.java', 'Java', ['com.acme.util.Strings', 'java.util.List']), f('src/main/java/com/acme/util/Strings.java', 'Java'),
    f('geo/main.cpp', 'C++', ['point.h']), f('geo/point.h', 'C++'),
  ];
  const edges = resolveImports(files).map(([a, b]) => `${a.slice(2)} -> ${b.slice(2)}`).sort();
  assert.deepEqual(edges, [
    'app/main.py -> app/db.py', 'app/main.py -> app/utils.py',
    'geo/main.cpp -> geo/point.h',
    'src/main/java/com/acme/App.java -> src/main/java/com/acme/util/Strings.java',
    'web/index.ts -> web/api/index.ts',
  ]);
});

test('graph: folders, files, functions on demand, fan-in, crawl covers everything', () => {
  const files = [f('a/x.py', 'Python', ['.y'], { fns: [{ name: 'run', line: 3, grade: 'C', cc: 9 }], kp: [1, 2, 0] }), f('a/y.py', 'Python'), f('z.py', 'Python', ['a.y'])];
  const g = buildGraph(files, { functions: false, expanded: new Set() });
  assert.ok(g.nodes.has('dir:a') && g.nodes.has('file:k:a/x.py'));
  assert.ok(![...g.nodes.keys()].some((k) => k.startsWith('fn:')), 'functions hidden by default');
  assert.equal(g.nodes.get('file:k:a/y.py')!.fanIn, 2);
  assert.deepEqual(g.nodes.get('file:k:a/x.py')!.kp, [1, 2, 0]);
  const g2 = buildGraph(files, { functions: false, expanded: new Set(['k:a/x.py']) });
  assert.ok(g2.nodes.has('fn:k:a/x.py#3'), 'double-clicked file shows its functions');
  for (const mode of ['bfs', 'dfs'] as const) {
    const o = crawlOrder(g2, mode);
    assert.equal(o[0].id, 'root');
    assert.equal(new Set(o.map((x) => x.id)).size, g2.nodes.size, `${mode} visits every node once`);
  }
});
