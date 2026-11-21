/* =============================================================================
 * KASAUTI — scripts/gen-rule-pages.mjs   (v2.0)
 * -----------------------------------------------------------------------------
 * WHAT:  Writes media/rules/KPxxx.md for every audit rule and appends them to
 *        media/rules/index.md, straight from src/audit/catalog.ts.
 * WHY:   The catalog is the single source of truth; hand-copying 26 pages
 *        would drift. A test (activation.test.ts) fails if any page is missing.
 * FLOW:  node scripts/gen-rule-pages.mjs  (run after editing catalog.ts)
 * ========================================================================== */
import * as esbuild from 'esbuild';
import fs from 'fs';
import { createRequire } from 'module';

const out = 'dist-test/catalog.cjs';
await esbuild.build({ entryPoints: ['src/audit/catalog.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const { AUDIT_RULES } = createRequire(import.meta.url)('../' + out);
const CAT = { performance: 'Performance', security: 'Security', 'ai-risk': 'AI-risk', simplify: 'Simplify' };

for (const r of AUDIT_RULES) {
  const ex = r.example ? `\n## Before → after\n\n\`\`\`\n${r.example.before}\n\`\`\`\n\n\`\`\`\n${r.example.after}\n\`\`\`\n` : '';
  fs.writeFileSync(`media/rules/${r.id}.md`, `# ${r.id} — ${r.name}

${r.summary}

**Category:** ${CAT[r.category]} · **Languages:** ${r.languages}

## Why it matters

${r.why}

## How to fix

${r.fix.map((f) => `- ${f}`).join('\n')}
${ex}
## Turning it off

Suppress one line with a \`kasauti-disable-next-line ${r.id}\` comment, or hide every audit rule with \`kasauti.audit.enabled: false\`.

---

Part of [KASAUTI](index.md) — v2.0 360° audit (deterministic, no AI involved in finding it).
`);
}

const idx = 'media/rules/index.md';
let text = fs.readFileSync(idx, 'utf8').split('\n## v2.0 — 360° audit rules')[0].trimEnd();
text += `\n\n## v2.0 — 360° audit rules\n\nFound deterministically on the same parse tree as the metrics. No limits to configure: each rule is a code shape.\n\n| Rule | What it checks | Category | Languages |\n|---|---|---|---|\n`
  + AUDIT_RULES.map((r) => `| [${r.id}](${r.id}.md) | ${r.name.replace(/\|/g, '\\|')} | ${CAT[r.category]} | ${r.languages} |`).join('\n') + '\n';
fs.writeFileSync(idx, text);
console.log(`wrote ${AUDIT_RULES.length} rule pages`);
