/* =============================================================================
 * KASAUTI — test/audit.test.ts   (v2.0)
 * -----------------------------------------------------------------------------
 * WHAT:  Locks the behaviour of the 360° audit: every KP rule fires on the
 *        shape it is meant for, and stays SILENT on the look-alike safe shape
 *        (false positives are what make people turn a linter off).
 * WHY:   The audit is the judge that AI fixes are verified against; a judge
 *        that drifts silently would approve bad code.
 * FLOW:  `npm test` -> esbuild bundles -> node --test runs this file.
 * ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { analyze } from '../src/engine/analyzer';
import { ParserService } from '../src/engine/parser';
import { evaluate, DEFAULT_THRESHOLDS, RULES } from '../src/engine/rules';
import { scanSecrets } from '../src/audit/secrets';
import { AUDIT_RULES } from '../src/audit/catalog';

const parser = new ParserService(path.resolve(__dirname, '..', 'dist/wasm'));
const ids = async (lang: string, src: string, file = 'x') => (await analyze(parser, lang, file, src)).audit!.map((f) => f.ruleId).sort();
const has = (list: string[], id: string, n = 1) => assert.equal(list.filter((x) => x === id).length, n, `${id} expected ${n}x in [${list.join(', ')}]`);

test('audit: python performance rules (KP101–KP106)', async () => {
  const src = [
    'def common(xs, ys):',
    '    seen = []',
    '    out = ""',
    '    for a in xs:',
    '        for b in ys:',
    '            if a == b and a not in seen:',      // KP102: list membership in loop
    '                seen.append(a)',
    '        out += str(a)',                          // KP104
    '        xs.sort()',                              // KP106
    '        q = ys.pop(0)',                          // KP103 (shift)
    '    return seen',
    '',
    'def fib(n):',
    '    if n < 2:',
    '        return n',
    '    return fib(n - 1) + fib(n - 2)',             // KP105
    '',
    'def small(grid):',
    '    for r in range(3):',                         // constant loop: must NOT count
    '        for c in grid:',
    '            print(r, c)',
  ].join('\n');
  const got = await ids('python', src);
  has(got, 'KP101', 1);           // common() only — small() has one input-sized loop
  has(got, 'KP102'); has(got, 'KP103'); has(got, 'KP104'); has(got, 'KP105'); has(got, 'KP106');
  const a = await analyze(parser, 'python', 'x.py', src);
  assert.match(a.audit!.find((f) => f.ruleId === 'KP101')!.message, /O\(n²\)/);
});

test('audit: memoized recursion and set membership stay silent', async () => {
  const src = [
    'from functools import lru_cache',
    '@lru_cache(maxsize=None)',
    'def fib(n):',
    '    return n if n < 2 else fib(n - 1) + fib(n - 2)',
    'def uniq(xs):',
    '    seen = set()',
    '    for x in xs:',
    '        if x not in seen:',
    '            seen.add(x)',
    '    return seen',
  ].join('\n');
  assert.deepEqual(await ids('python', src), []);
});

test('audit: python security rules (KP201–KP207)', async () => {
  const src = [
    'import os, subprocess, pickle, yaml, hashlib, requests',
    'def run(user, host, cur, blob):',
    '    eval(user)',                                                   // KP201 critical
    '    os.system("ping " + host)',                                    // KP202 critical
    '    subprocess.run(["ls", host])',                                 // safe: list, no shell
    '    subprocess.run("ls", shell=True)',                             // KP202 major (literal)
    '    cur.execute(f"SELECT * FROM users WHERE name = \'{user}\'")',   // KP203
    '    cur.execute("SELECT * FROM users WHERE name = %s", (user,))',   // safe: parameters
    '    pickle.loads(blob)',                                           // KP205
    '    yaml.load(blob)',                                              // KP205
    '    yaml.load(blob, Loader=yaml.SafeLoader)',                      // safe
    '    hashlib.md5(blob)',                                            // KP207
    '    requests.get(host, verify=False)',                             // KP206
  ].join('\n');
  const a = await analyze(parser, 'python', 'x.py', src);
  const got = a.audit!.map((f) => f.ruleId).sort();
  has(got, 'KP201'); has(got, 'KP202', 2); has(got, 'KP203', 1); has(got, 'KP205', 2); has(got, 'KP206'); has(got, 'KP207');
  assert.equal(a.audit!.find((f) => f.ruleId === 'KP201')!.severity, 'critical');
  const sev = a.audit!.filter((f) => f.ruleId === 'KP202').map((f) => f.severity).sort();
  assert.deepEqual(sev, ['critical', 'major'], 'dynamic command critical, fixed command major');
});

test('audit: python AI-risk + simplify rules (KP304–KP307, KP401–KP405)', async () => {
  const src = [
    'def load(path, cache={}):',                 // KP307
    '    try:',
    '        return open(path).read()',
    '    except:',                                // KP304 (bare + silent)
    '        pass',
    '',
    'def todo(x):',
    '    pass',                                   // KP305 stub
    '',
    'def adult(age):',
    '    if age >= 18:',                          // KP401
    '        return True',
    '    else:',
    '        return False',
    '',
    'def f(items, flag, y):',
    '    # ... rest of the code',                 // KP305 placeholder comment
    '    if flag == True:',                       // KP402
    '        pass',
    '    if y == None:',                          // KP405
    '        pass',
    '    if len(items) == 0:',                    // KP405
    '        return 0',
    '    total = 0',
    '    for x in items:',                        // KP404
    '        total += x',
    '    for i in range(len(items)):',            // KP403
    '        print(items[i])',
    '    return total',
    '    print("never")',                         // KP306
  ].join('\n');
  const got = await ids('python', src);
  for (const id of ['KP304', 'KP306', 'KP307', 'KP401', 'KP402', 'KP403', 'KP404']) has(got, id);
  has(got, 'KP305', 2); has(got, 'KP405', 2);
});

test('audit: abstract methods and .pyi stubs are not "placeholders"', async () => {
  const src = 'from abc import ABC, abstractmethod\nclass Shape(ABC):\n    @abstractmethod\n    def area(self):\n        ...\n';
  assert.deepEqual(await ids('python', src), []);
  assert.deepEqual(await ids('python', 'def f(x: int) -> int: ...\n', 'types.pyi'), []);
});

test('audit: javascript rules', async () => {
  const src = [
    "const cp = require('child_process');",
    'function g(a, b, user, el, db) {',
    '  for (const x of a) {',
    '    for (const y of b) {',
    '      if (a.indexOf(y) > -1) {}',            // KP103 (+ KP101 via nesting)
    '    }',
    '  }',
    '  cp.exec(`rm ${user}`);',                    // KP202 critical
    '  db.query(`SELECT * FROM t WHERE id = ${user}`);',  // KP203
    '  el.innerHTML = user;',                      // KP208
    '  el.innerHTML = "<b>ok</b>";',               // safe literal
    '  eval(user);',                               // KP201
    '  try { g(); } catch (e) {}',                 // KP304
    '  if (user === true) {}',                     // KP402
    '  const o = { rejectUnauthorized: false };',  // KP206
    '  if (a) { return true; } else { return false; }', // KP401
    '}',
  ].join('\n');
  const got = await ids('javascript', src);
  for (const id of ['KP101', 'KP103', 'KP202', 'KP203', 'KP208', 'KP201', 'KP304', 'KP402', 'KP206', 'KP401']) has(got, id);
  assert.deepEqual(await ids('typescript', 'export const f = (xs: number[]): number => xs.length;\n'), []);
});

test('audit: java rules', async () => {
  const src = [
    'import java.util.*; import java.security.MessageDigest;',
    'class A {',
    '  String join(List<String> xs, Set<String> s) throws Exception {',
    '    String out = "";',
    '    for (String x : xs) {',
    '      out += x;',                                   // KP104
    '      if (xs.contains(x)) {}',                      // KP103 (List)
    '      if (s.contains(x)) {}',                       // HashSet: silent
    '    }',
    '    Runtime.getRuntime().exec("ls " + out);',       // KP202 critical
    '    MessageDigest.getInstance("MD5");',              // KP207
    '    try { foo(); } catch (Exception e) { }',         // KP304
    '    return out;',
    '  }',
    '}',
  ].join('\n');
  const got = await ids('java', src);
  for (const id of ['KP104', 'KP202', 'KP207', 'KP304']) has(got, id);
  has(got, 'KP103', 1);
});

test('audit: secrets are found in any language and masked in the message', () => {
  // Built by concatenation so this test file never contains a key-shaped
  // literal (GitHub push protection rejects those — it happened to PyraSec).
  const fake = 'gh' + 'p_' + 'Zq9'.repeat(13);
  const f = scanSecrets(`token = "${fake}"\npassword = "${'hunter' + '2hunter2'}"\napi_key = os.environ["KEY"]\npassword = "your_password_here"`);
  assert.deepEqual(f.map((x) => [x.ruleId, x.severity, x.line]), [['KP204', 'critical', 0], ['KP204', 'major', 1]]);
  assert.ok(!f[0].message.includes(fake), 'the key must be masked');
  assert.ok(!f[1].message.includes('hunter2hunter2'));
});

test('audit: secrets are scanned in Tier 2 (no grammar) files too', async () => {
  const a = await analyze(parser, 'tier2:pascal', 'x.pas', `const k = '${'AKIA' + 'Q7RT'.repeat(4)}';\n`);
  assert.equal(a.tier, 2);
  assert.deepEqual(a.audit!.map((x) => x.ruleId), ['KP204']);
});

test('audit: findings flow through evaluate() and can be switched off', async () => {
  const a = await analyze(parser, 'python', 'x.py', 'def f(x):\n    eval(x)\n');
  assert.ok(evaluate(a, DEFAULT_THRESHOLDS).some((f) => f.ruleId === 'KP201'));
  assert.ok(!evaluate(a, DEFAULT_THRESHOLDS, false).some((f) => f.ruleId === 'KP201'));
});

test('audit: every KP rule is in the catalog with why, fix and a category', () => {
  const ids2 = new Set(RULES.map((r) => r.id));
  for (const r of AUDIT_RULES) {
    assert.ok(ids2.has(r.id), r.id);
    assert.ok(r.why.length > 40 && r.fix.length > 0, `${r.id} needs why + fix`);
  }
  assert.equal(AUDIT_RULES.length, 26);
});

test('audit: KP findings can be silenced with kasauti-disable-next-line KP201', async () => {
  const { applySuppressions } = await import('../src/engine/suppress');
  const a = await analyze(parser, 'python', 'x.py', 'def f(x):\n    # kasauti-disable-next-line KP201\n    eval(x)\n');
  const left = applySuppressions(evaluate(a, DEFAULT_THRESHOLDS), a.suppressions);
  assert.ok(!left.some((f) => f.ruleId === 'KP201'));
});
