/* =============================================================================
 * KASAUTI — engine/imports.ts   (v2.1 Code Map)
 * -----------------------------------------------------------------------------
 * WHAT:  Pulls the raw import / include specifiers out of a source file:
 *          Python  `import a.b` · `from .x import y`   -> 'a.b', '.x'
 *          JS/TS   `import … from './x'` · require('y') -> './x', 'y'
 *          Java    `import com.acme.Util;`              -> 'com.acme.Util'
 *          C/C++   `#include "util.h"`                  -> 'util.h'
 *          Go      `import "pkg/x"`                     -> 'pkg/x'
 * WHY:   The Code Map (NeuralSchema-style graph) draws an edge from a file to
 *        every OTHER project file it imports. Here we only collect the
 *        strings — cheap regexes in the worker; matching them to real files
 *        happens in the webview (webview/schemaGraph.ts), which knows every
 *        path in the workspace.
 * FLOW:  analyzer.ts -> FileAnalysis.imports -> snapshot.ts UiFile.imp ->
 *        webview/schemaGraph.ts resolveImports() -> import edges.
 * ========================================================================== */

/** Max specifiers kept per file: a 3,000-import generated file must not bloat
 *  every live-update message. */
const CAP = 120;

const PATTERNS: Record<string, RegExp[]> = {
  python: [/^\s*from\s+(\.*[\w.]*)\s+import\b/gm, /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm],
  js: [/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g],
  java: [/^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/gm],
  c: [/^\s*#\s*include\s*"([^"]+)"/gm],
  go: [/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm],
};

function dialect(languageKey: string): keyof typeof PATTERNS | undefined {
  if (languageKey === 'python' || languageKey === 'notebook:python') return 'python';
  if (/^(javascript|typescript|tsx)$/.test(languageKey)) return 'js';
  if (languageKey === 'java' || languageKey === 'kotlin' || languageKey === 'scala') return 'java';
  if (/^(c|cpp|objc)$/.test(languageKey)) return 'c';
  if (languageKey === 'go') return 'go';
  return undefined;
}

export function extractImportSpecs(languageKey: string, text: string): string[] {
  const d = dialect(languageKey);
  if (!d) return [];
  const out = new Set<string>();
  for (const re of PATTERNS[d]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && out.size < CAP) {
      const raw = d === 'js' ? m[2] : m[1];
      // `import a, b.c` lists several modules on one line.
      for (const s of (d === 'python' && !raw.startsWith('.') ? raw.split(',') : [raw])) {
        const spec = s.trim().split(/\s+/)[0];
        if (spec) out.add(spec);
      }
    }
  }
  // Go: `import ( "a" ; alias "b" )` blocks.
  if (d === 'go') for (const b of text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) for (const q of b[1].matchAll(/"([^"]+)"/g)) if (out.size < CAP) out.add(q[1]);
  return [...out];
}
