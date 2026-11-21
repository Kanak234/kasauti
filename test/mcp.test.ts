/* =============================================================================
 * KASAUTI — test/mcp.test.ts   (v2.0)
 * -----------------------------------------------------------------------------
 * WHAT:  Starts the real bundled server (dist/mcp.js) the way a harness does,
 *        speaks MCP JSON-RPC to it over stdio, and checks every answer.
 * WHY:   Agents only see what goes over the pipe. One stray console.log on
 *        stdout would corrupt the protocol for every harness — this test
 *        would catch it.
 * FLOW:  `npm test` (needs `npm run build` first; the test script does it).
 * ========================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { spawn } from 'child_process';
import * as readline from 'readline';

function startServer(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'dist/mcp.js')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: child.stdout });
  const waiting = new Map<number, (m: any) => void>();
  const stray: string[] = [];
  rl.on('line', (l) => { let m; try { m = JSON.parse(l); } catch { stray.push(l); return; } waiting.get(m.id)?.(m); });
  let id = 0;
  const call = (method: string, params?: object) => new Promise<any>((res) => { const i = ++id; waiting.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { call, notify, stray, stop: () => child.kill() };
}

test('mcp: handshake, tool list, audit, package check, exec gate', async () => {
  const s = startServer();
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'kasauti');
    assert.ok(init.result.capabilities.tools);
    s.notify('notifications/initialized');
    const list = await s.call('tools/list');
    assert.deepEqual(list.result.tools.map((t: any) => t.name).sort(),
      ['kasauti_audit_code', 'kasauti_audit_file', 'kasauti_check_packages', 'kasauti_prove_complexity', 'kasauti_verify_fix']);

    const audit = await s.call('tools/call', { name: 'kasauti_audit_code', arguments: { language: 'python', code: 'def f(user, cur):\n    cur.execute(f"SELECT * FROM t WHERE a = {user}")\n' } });
    assert.equal(audit.result.isError, false);
    assert.ok(audit.result.structuredContent.findings.some((f: any) => f.rule === 'KP203' && f.line === 2));

    const pk = await s.call('tools/call', { name: 'kasauti_check_packages', arguments: { ecosystem: 'pypi', packages: ['json'] } });
    assert.match(pk.result.structuredContent.results[0].verdict, /standard library/);

    const gated = await s.call('tools/call', { name: 'kasauti_prove_complexity', arguments: { language: 'python', function: 'f', code: 'def f(xs):\n    return xs\n' } });
    assert.equal(gated.result.isError, true);
    assert.match(gated.result.content[0].text, /KASAUTI_ALLOW_EXEC/);

    const vf = await s.call('tools/call', { name: 'kasauti_verify_fix', arguments: { language: 'python', function: 'f',
      original: 'def f(xs):\n    return sorted(xs)\n', candidate: 'import os\ndef f(xs):\n    os.system("rm -rf " + str(xs))\n    return sorted(xs)\n' } });
    assert.equal(vf.result.structuredContent.verdict, 'REJECT');

    const bad = await s.call('no/such/method');
    assert.equal(bad.error.code, -32601);
    assert.deepEqual(s.stray, [], 'nothing but JSON-RPC may appear on stdout');
  } finally { s.stop(); }
});
