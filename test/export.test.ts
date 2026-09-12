/* =============================================================================
 * KASAUTI — test/export.test.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Verifies the three export formats against real requirements:
 *        - SARIF output validates against the official SARIF 2.1.0 JSON schema
 *          (bundled offline in test/fixtures) — SPEC §A10.5
 *        - JSON contains every metric, with 1-based line numbers
 *        - HTML is self-contained: no http(s) references at all, so it opens
 *          offline (SPEC FR-10/FR-11), and renders a treemap + sortable table
 * FLOW:  `npm test`
 * ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
// The OASIS schema is written against JSON Schema draft-04, so the matching
// validator build is required (plain Ajv 8 defaults to 2020-12).
import Ajv from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { JSDOM } from 'jsdom';
import { toHTML, toJSON, toSARIF } from '../src/export/report';
import { ResultStore } from '../src/store';
import { DEFAULT_THRESHOLDS } from '../src/engine/rules';
import { WorkerPool } from '../src/workerPool';

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'dist/worker.js');
const WASM = path.join(ROOT, 'dist/wasm');

/** A workspace with real problems: complexity, duplication, long lines. */
async function buildStore(): Promise<ResultStore> {
  const pool = new WorkerPool(WORKER, WASM, 2);
  try {
    const store = new ResultStore(DEFAULT_THRESHOLDS);
    const heavy = `def heavy(a, b, c, d, e, f, g, h):\n    total = 0\n` +
      Array.from({ length: 14 }, (_, i) => `    if a > ${i} and b < ${i}:\n        for x in range(${i}):\n            while x > 0:\n                total += ${i}  # ${'padding '.repeat(20)}\n`).join('') +
      `    return total\n`;
    const shared = Array.from({ length: 8 }, (_, i) =>
      `def helper${i}(items):\n    out = []\n    for it in items:\n        if it.value > ${i}:\n            out.append(it.name.upper())\n    return out\n`).join('\n');
    store.set('file:///w/src/heavy.py', 'src/heavy.py', await pool.analyze({ languageKey: 'python', path: 'heavy.py', text: heavy }), true);
    store.set('file:///w/src/a.py', 'src/a.py', await pool.analyze({ languageKey: 'python', path: 'a.py', text: shared }), true);
    store.set('file:///w/lib/b.py', 'lib/b.py', await pool.analyze({ languageKey: 'python', path: 'b.py', text: shared + '\nprint(1)\n' }), true);
    store.set('file:///w/legacy/old.pas', 'legacy/old.pas', await pool.analyze({ languageKey: 'tier2:pascal', path: 'old.pas', text: 'program P;\nbegin\n  writeln(1); { TODO: fix }\nend.\n' }), true);
    return store;
  } finally { pool.dispose(); }
}

test('SARIF export validates against the official SARIF 2.1.0 schema', async () => {
  const store = await buildStore();
  const sarif = JSON.parse(toSARIF(store, '0.1.0')) as { runs: Array<{ tool: { driver: { name: string; rules: Array<{ id: string }> } }; results: Array<{ ruleId: string; ruleIndex: number; locations: Array<{ physicalLocation: { region: { startLine: number }; artifactLocation: { uri: string } } }> }> }> };
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/sarif-2.1.0.json'), 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const ok = validate(sarif);
  assert.ok(ok, 'SARIF invalid: ' + JSON.stringify(validate.errors?.slice(0, 4), null, 1));
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, 'KASAUTI');
  assert.equal(run.tool.driver.rules.length, 12);
  assert.ok(run.results.length > 5);
  // Rule references must resolve, and locations must be 1-based.
  for (const r of run.results) {
    assert.equal(run.tool.driver.rules[r.ruleIndex].id, r.ruleId);
    assert.ok(r.locations[0].physicalLocation.region.startLine >= 1);
    assert.ok(!r.locations[0].physicalLocation.artifactLocation.uri.startsWith('/'));
  }
});

test('JSON export carries every metric with 1-based lines', async () => {
  const store = await buildStore();
  const j = JSON.parse(toJSON(store, '0.1.0'));
  assert.equal(j.tool, 'KASAUTI');
  assert.ok(['A', 'B', 'C', 'D', 'E'].includes(j.workspace.grade));
  assert.equal(j.files.length, 4);
  const heavy = j.files.find((f: { path: string }) => f.path === 'src/heavy.py');
  assert.equal(heavy.tier, 1);
  const fn = heavy.functions[0];
  assert.equal(fn.line, 1, 'first line is 1, not 0');
  assert.ok(fn.cyclomatic > 10 && fn.cognitive > 15 && fn.halstead.volume > 0 && fn.maintainabilityIndex >= 0);
  assert.ok(heavy.findings.some((f: { rule: string }) => f.rule === 'CQ001'));
  const partial = j.files.find((f: { path: string }) => f.path === 'legacy/old.pas');
  assert.equal(partial.tier, 2);
  assert.equal(partial.language, 'Pascal');
});

test('HTML export is self-contained, offline, and renders the report', async () => {
  const store = await buildStore();
  const html = toHTML(store, '0.1.0', 'demo-workspace');
  assert.ok(!/https?:\/\//.test(html.replace(/SonarQube|SonarSource/g, '')), 'no external URLs');
  assert.ok(!/<script[^>]+src=/.test(html), 'no external scripts');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const doc = dom.window.document;
  assert.match(doc.title, /demo-workspace/);
  assert.ok(doc.querySelector('svg.treemap rect'), 'treemap drawn');
  const rows = () => [...doc.querySelectorAll('#files tbody tr')].map((tr) => tr.querySelector('td')!.textContent);
  assert.equal(rows().length, 4);
  assert.equal(rows()[0], 'src/heavy.py', 'most debt first');
  // The inline sorter must work with no network and no framework.
  (doc.querySelectorAll('#files th')[0] as HTMLElement).click();
  assert.equal(rows()[0], 'legacy/old.pas', 'sorted by file name ascending');
  assert.match(doc.querySelector('footer')!.textContent!, /technical-debt-ratio/);
});
