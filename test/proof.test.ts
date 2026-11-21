/* =============================================================================
 * KASAUTI — test/proof.test.ts   (v2.0)
 * WHAT:  The proof panel HTML: model output is escaped (prompt-injected markup
 *        must not render), Apply only appears for a verified fix, the chart
 *        and the KP watermark are present.
 * WHY:   The panel shows text written by an untrusted model inside a webview.
 * ========================================================================== */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proofHtml } from '../src/views/proofHtml';
import type { FixReport } from '../src/ai/verify';

const LOGO = '<svg id="kp"></svg>';
const report = (passed: boolean): FixReport => ({ passed, provider: 'Fake', fixedRules: passed ? ['KP102'] : [], remainingRules: [],
  code: passed ? 'def f(x):\n    return x\n' : undefined,
  attempts: [{ n: 1, code: '<img src=x onerror=alert(1)>', answerPreview: '', checks: [{ id: 'behaviour', title: 'Same behaviour', status: passed ? 'pass' : 'fail', detail: '<script>bad()</script>' }] }],
  perf: passed ? { before: 'O(n²)', after: 'O(n)', beforePoints: [{ n: 10, t: 1e-4 }, { n: 100, t: 1e-2 }], afterPoints: [{ n: 10, t: 1e-5 }, { n: 100, t: 1e-4 }] } : undefined });

test('proof panel: untrusted text is escaped, Apply only when verified', () => {
  const ok = proofHtml({ kind: 'fix', fnName: 'f', file: 'a.py', report: report(true) }, 'N', 'csp', LOGO);
  assert.ok(!ok.includes('<script>bad()'), 'model text must be escaped');
  assert.ok(!ok.includes('<img src=x'), 'model code must be escaped');
  assert.match(ok, /id="apply"/);
  assert.match(ok, /<svg class="chart"/);
  assert.match(ok, /KASAUTI by Kanak Prabhakar/);
  assert.equal((ok.match(/<script/g) ?? []).length, 1, 'only our own nonce script');
  const bad = proofHtml({ kind: 'fix', fnName: 'f', file: 'a.py', report: report(false) }, 'N', 'csp', LOGO);
  assert.ok(!bad.includes('id="apply"'));
  assert.match(bad, /Nothing was changed/);
});
