/* =============================================================================
 * KASAUTI — audit/secrets.ts   (v2.0 "Parakh")
 * -----------------------------------------------------------------------------
 * WHAT:  KP204 (hard-coded secrets) and the text-level part of KP206 (TLS
 *        verification disabled in Java), found by scanning raw source lines.
 * WHY:   Secrets leak from ANY file type — Go, YAML-in-a-string, a notebook,
 *        a Pascal file with no grammar. A line scan works for every language
 *        and every tier, so this runs for Tier 1 AND Tier 2 files.
 *        Values are masked in messages: the report must never re-leak the key
 *        (it may end up in a SARIF file, a screenshot, or an AI prompt).
 * FLOW:  engine/analyzer.ts -> scanSecrets(source) -> FileAnalysis.audit
 * ========================================================================== */

import type { Finding } from '../engine/types';

/** Provider-specific token formats. A match here is almost never a false
 *  positive, so these are 'critical'. Patterns are written so that this file
 *  itself contains no string that looks like a real key. */
const TOKEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style API key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'NVIDIA API key', re: /\bnvapi-[A-Za-z0-9_-]{30,}/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Stripe live key', re: /\b[sr]k_live_[0-9a-zA-Z]{20,}/ },
  { name: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}/ },
  { name: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
];

/** `password = "…"` style assignments. Lower confidence -> 'major'. */
const ASSIGNMENT = /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*(["'])([^"'\s]{8,})\2/i;

/** Values that are obviously not real secrets (docs, tests, templates). */
const PLACEHOLDER = /^(your|my|xxx|change|example|sample|test|dummy|placeholder|redacted|secret|password|none|null|todo|<|\$\{|\{\{|\*{3,}|\.{3})/i;
/** Lines that read the secret from somewhere safe are fine. */
const SAFE_SOURCE = /(os\.environ|getenv|process\.env|System\.getenv|config\[|settings\.|vault|keyring|secrets\.get)/;
/** Known documentation example values (AWS publishes these on purpose). */
const KNOWN_EXAMPLE = /EXAMPLE|DOCUMENTATION|abcdef|123456/;

/** Show enough to recognise the key, never enough to use it. */
export function mask(v: string): string { return v.length <= 8 ? '****' : `${v.slice(0, 4)}…${'*'.repeat(4)} (${v.length} chars)`; }

/** Scan every line of a file. Pure: same text -> same findings. */
export function scanSecrets(text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue;                // minified/data blobs: skip, not our job
    let hit = false;
    for (const p of TOKEN_PATTERNS) {
      const m = p.re.exec(line);
      if (!m || KNOWN_EXAMPLE.test(m[0])) continue;
      out.push({ ruleId: 'KP204', severity: 'critical', debtMinutes: 30, line: i, col: m.index, endLine: i, endCol: m.index + m[0].length,
        message: `${p.name} written in the source (${mask(m[0])}). Move it to an environment variable and ROTATE it — assume it has leaked.` });
      hit = true;
      break;                                          // one finding per line
    }
    if (hit) continue;
    const a = ASSIGNMENT.exec(line);
    if (a && !PLACEHOLDER.test(a[3]) && !SAFE_SOURCE.test(line) && !KNOWN_EXAMPLE.test(a[3])) {
      const col = a.index;
      out.push({ ruleId: 'KP204', severity: 'major', debtMinutes: 20, line: i, col, endLine: i, endCol: col + a[0].length,
        message: `'${a[1]}' is assigned a literal value (${mask(a[3])}). Read it from an environment variable or a secrets manager instead.` });
    }
    // Java TLS: trust-everything helpers (text level; their call shapes vary too much).
    if (/\b(NoopHostnameVerifier|ALLOW_ALL_HOSTNAME_VERIFIER|TrustAllStrategy|TrustSelfSignedStrategy)\b/.test(line))
      out.push({ ruleId: 'KP206', severity: 'major', debtMinutes: 20, line: i, col: 0, endLine: i, endCol: line.length,
        message: 'A trust-everything TLS helper is used — certificate/hostname checks are off, so traffic can be intercepted.' });
  }
  return out;
}
