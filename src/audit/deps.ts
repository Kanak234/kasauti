/* =============================================================================
 * KASAUTI — audit/deps.ts   (v2.0 "Parakh")
 * -----------------------------------------------------------------------------
 * WHAT:  The slopsquatting guard (KP301–KP303):
 *          1. extractImports()  — which packages does this file import?
 *          2. parseManifest()   — which packages does the project declare?
 *          3. checkImports()    — imported but undeclared?            (KP301)
 *          4. checkRegistry()   — does the name exist on PyPI / npm,
 *                                 and how old is it?                  (KP302/303)
 * WHY:   AI assistants invent package names; attackers register those names
 *        with malware. Catching it at the import line — before `pip install` —
 *        is the cheapest place to stop it.
 *        Steps 1–3 are pure and offline. Step 4 touches the network, so it is
 *        OFF by default (kasauti.audit.checkRegistry) and `fetch` is injected
 *        so tests never hit the internet.
 * FLOW:  controller.ts (editor) / cli.ts / mcp/server.ts read manifests from
 *        disk -> checkImports() -> store.setExternal(key, findings) -> views.
 * ========================================================================== */

import type { Finding } from '../engine/types';
import { NODE_BUILTINS, PYTHON_STDLIB } from './stdlib';

export type Ecosystem = 'pypi' | 'npm';
export interface ImportRef { name: string; line: number; col: number; ecosystem: Ecosystem }

export function ecosystemOf(languageKey: string): Ecosystem | undefined {
  if (languageKey === 'python' || languageKey === 'notebook:python') return 'pypi';
  if (languageKey === 'javascript' || languageKey === 'typescript' || languageKey === 'tsx') return 'npm';
  return undefined;
}

/* ---------------------------------------------------------------------------
 * 1. Imports. Regex, not AST: this runs on the host thread (the parse tree
 *    lives in the worker) and import syntax is regular enough. Strings and
 *    comments that merely mention "import x" are excluded by anchoring at the
 *    start of the line (Python) or by requiring a quoted module (JS).
 * ------------------------------------------------------------------------- */
export function extractImports(languageKey: string, text: string): ImportRef[] {
  const eco = ecosystemOf(languageKey);
  if (!eco) return [];
  if (languageKey === 'notebook:python') {
    try {   // notebooks: only code cells, joined like analyzer.ts does
      const nb = JSON.parse(text) as { cells?: Array<{ cell_type: string; source: string | string[] }> };
      text = (nb.cells ?? []).filter((c) => c.cell_type === 'code').map((c) => (Array.isArray(c.source) ? c.source.join('') : c.source)).join('\n');
    } catch { return []; }
  }
  const out: ImportRef[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (eco === 'pypi') {
      // `import a.b as c, d`   |   `from a.b import c`   (relative `from .x` is local)
      let m = /^\s*import\s+(.+)$/.exec(line);
      if (m) {
        for (const part of m[1].split('#')[0].split(',')) {
          const name = part.trim().split(/\s+/)[0]?.split('.')[0];
          if (name && /^[A-Za-z_]\w*$/.test(name)) out.push({ name, line: i, col: line.indexOf(name), ecosystem: eco });
        }
        return;
      }
      m = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line);
      if (m) { const name = m[1].split('.')[0]; out.push({ name, line: i, col: line.indexOf(name), ecosystem: eco }); }
      return;
    }
    // JS/TS: import … from 'x' | import 'x' | require('x') | import('x') | export … from 'x'
    const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const spec = m[2];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || /^[a-z]+:/.test(spec)) continue;   // relative, absolute, URL
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      out.push({ name, line: i, col: m.index + m[0].indexOf(spec), ecosystem: eco });
    }
  });
  return out;
}

/* ---------------------------------------------------------------------------
 * 2. Manifests. Loose line parsers: we only need NAMES, never versions, and a
 *    loose parser that misses an exotic syntax fails safe (it simply flags an
 *    import as undeclared, which the user can see is wrong).
 * ------------------------------------------------------------------------- */

/** PEP 503 normalisation: "Scikit_Learn" == "scikit-learn". */
export const normalize = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

/** Requirement string -> bare name: "requests[socks]>=2.0 ; python_version<'3'" -> "requests". */
const reqName = (s: string) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s)?.[1];

export function parseManifest(fileName: string, text: string): { ecosystem: Ecosystem; names: string[] } | undefined {
  const base = fileName.split(/[\\/]/).pop()!.toLowerCase();
  if (base === 'package.json') {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
        .flatMap((k) => Object.keys((j[k] as Record<string, string>) ?? {}));
      if (typeof j.name === 'string') names.push(j.name);   // importing yourself is fine
      return { ecosystem: 'npm', names };
    } catch { return undefined; }
  }
  if (/^requirements.*\.(txt|in)$/.test(base) || base === 'constraints.txt') {
    const names = text.split(/\r?\n/).map((l) => l.split('#')[0].trim()).filter((l) => l && !l.startsWith('-'))
      .map((l) => (/#egg=([\w.-]+)/.exec(l)?.[1] ?? reqName(l))).filter((x): x is string => !!x);
    return { ecosystem: 'pypi', names };
  }
  if (base === 'pyproject.toml' || base === 'pipfile' || base === 'setup.py' || base === 'setup.cfg' || base === 'environment.yml') {
    const names: string[] = [];
    // Every quoted requirement-looking string ("numpy>=1.2", 'pandas') ...
    for (const m of text.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:[<>=!~;@ ][^"']*)?["']/g)) names.push(m[1]);
    // ... and TOML table keys under dependency tables (poetry / Pipfile): `numpy = "^1.2"`.
    let inDeps = false;
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('[')) { inDeps = /dependencies|packages/i.test(t); continue; }
      const k = inDeps ? /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(t)?.[1] : undefined;
      if (k && k.toLowerCase() !== 'python') names.push(k);
      // environment.yml: "  - numpy=1.2"
      const y = /^-\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(t)?.[1];
      if (base === 'environment.yml' && y) names.push(y);
    }
    // The project's own name is importable.
    const own = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
    if (own) names.push(own);
    return { ecosystem: 'pypi', names };
  }
  return undefined;
}

/** Manifest file names worth reading (used by the host to glob for them). */
export const MANIFEST_GLOB = '**/{package.json,requirements*.txt,requirements*.in,constraints.txt,pyproject.toml,Pipfile,setup.py,setup.cfg,environment.yml}';

/**
 * Import names that differ from the distribution you `pip install`.
 * WHY: without this, `import cv2` would always look undeclared, because the
 * requirements file says `opencv-python`. Every entry is a well-known case.
 */
export const PY_IMPORT_TO_DIST: Record<string, string[]> = {
  cv2: ['opencv-python', 'opencv-contrib-python', 'opencv-python-headless', 'opencv-contrib-python-headless'],
  PIL: ['pillow'], sklearn: ['scikit-learn'], skimage: ['scikit-image'], yaml: ['pyyaml'], bs4: ['beautifulsoup4'],
  dateutil: ['python-dateutil'], dotenv: ['python-dotenv'], jwt: ['pyjwt'], Crypto: ['pycryptodome', 'pycryptodomex', 'pycrypto'],
  OpenSSL: ['pyopenssl'], serial: ['pyserial'], usb: ['pyusb'], magic: ['python-magic'], docx: ['python-docx'],
  pptx: ['python-pptx'], fitz: ['pymupdf'], attr: ['attrs'], MySQLdb: ['mysqlclient'], psycopg2: ['psycopg2', 'psycopg2-binary'],
  telegram: ['python-telegram-bot'], discord: ['discord.py'], win32api: ['pywin32'], win32con: ['pywin32'], win32com: ['pywin32'],
  pywintypes: ['pywin32'], gi: ['pygobject'], zmq: ['pyzmq'], faiss: ['faiss-cpu', 'faiss-gpu'], Levenshtein: ['python-levenshtein', 'levenshtein'],
  mpl_toolkits: ['matplotlib'], pkg_resources: ['setuptools'], google: ['protobuf', 'google-api-python-client', 'google-cloud-storage', 'google-generativeai', 'google-genai', 'google-auth'],
  sentencepiece: ['sentencepiece'], tensorflow_hub: ['tensorflow-hub'], speech_recognition: ['speechrecognition'], pyaudio: ['pyaudio'],
  dns: ['dnspython'], nacl: ['pynacl'], ruamel: ['ruamel.yaml'], websocket: ['websocket-client'], socketio: ['python-socketio'],
  engineio: ['python-engineio'], jose: ['python-jose'], multipart: ['python-multipart'], slugify: ['python-slugify'], Bio: ['biopython'],
  lxml: ['lxml'], llama_cpp: ['llama-cpp-python'], tree_sitter: ['tree-sitter'], umap: ['umap-learn'], kafka: ['kafka-python'],
};

/** npm: `import x from '@types/…'` never happens, but type-only packages are
 *  declared as @types/x while imported as x. */
const npmCandidates = (name: string) => [name, `@types/${name.replace(/^@/, '').replace('/', '__')}`];

export interface DepContext {
  /** Normalised names from every manifest of this ecosystem in the project. */
  declared: Set<string>;
  /** True when at least one manifest exists. With none, KP301 stays silent. */
  hasManifest: boolean;
  /** Returns true if `name` is a module of the project itself (name.py, name/, src/name). */
  isLocal: (name: string) => boolean;
}

/** Is this import satisfied without looking at the network? */
export function classifyImport(ref: ImportRef, ctx: DepContext): 'stdlib' | 'local' | 'declared' | 'undeclared' {
  if (ref.ecosystem === 'pypi' ? PYTHON_STDLIB.has(ref.name) : NODE_BUILTINS.has(ref.name)) return 'stdlib';
  if (ctx.isLocal(ref.name)) return 'local';
  const candidates = ref.ecosystem === 'pypi' ? [ref.name, ...(PY_IMPORT_TO_DIST[ref.name] ?? [])] : npmCandidates(ref.name);
  if (candidates.some((c) => ctx.declared.has(normalize(c)))) return 'declared';
  return 'undeclared';
}

/** KP301 for one file. Each package is reported once (its first import). */
export function checkImports(languageKey: string, text: string, ctx: DepContext): Finding[] {
  if (!ctx.hasManifest) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const ref of extractImports(languageKey, text)) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    if (classifyImport(ref, ctx) !== 'undeclared') continue;
    const manifest = ref.ecosystem === 'pypi' ? 'requirements.txt / pyproject.toml' : 'package.json';
    out.push({ ruleId: 'KP301', severity: 'major', debtMinutes: 10, line: ref.line, col: ref.col, endLine: ref.line, endCol: ref.col + ref.name.length,
      message: `'${ref.name}' is imported but not declared in ${manifest}. If an AI suggested it, confirm it exists on ${ref.ecosystem === 'pypi' ? 'pypi.org' : 'npmjs.com'} before installing (slopsquatting).` });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 4. Registry lookup (opt-in). Results are cached for the session: a package
 *    that existed five minutes ago still exists, and we must not hammer PyPI
 *    while the user types.
 * ------------------------------------------------------------------------- */
export interface RegistryInfo { exists: boolean; created?: string; error?: string }
type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;
const registryCache = new Map<string, Promise<RegistryInfo>>();

export function lookupPackage(eco: Ecosystem, name: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<RegistryInfo> {
  const key = `${eco}:${name}`;
  const hit = registryCache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<RegistryInfo> => {
    const url = eco === 'pypi' ? `https://pypi.org/pypi/${encodeURIComponent(name)}/json` : `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (res.status === 404) return { exists: false };
      if (!res.ok) return { exists: true, error: `HTTP ${res.status}` };     // unknown -> do not accuse
      const j = (await res.json()) as Record<string, any>;
      if (eco === 'npm') return { exists: true, created: j.time?.created };
      // PyPI: earliest upload across all releases = first publication.
      let first: string | undefined;
      for (const files of Object.values((j.releases ?? {}) as Record<string, Array<{ upload_time_iso_8601?: string }>>))
        for (const f of files) if (f.upload_time_iso_8601 && (!first || f.upload_time_iso_8601 < first)) first = f.upload_time_iso_8601;
      return { exists: true, created: first };
    } catch (e) {
      registryCache.delete(key);                  // network error: allow a retry later
      return { exists: true, error: String((e as Error)?.message ?? e) };
    }
  })();
  registryCache.set(key, p);
  return p;
}

/** Age threshold for KP303 ("brand-new package"). */
export const NEW_PACKAGE_DAYS = 90;

/**
 * KP302/KP303 for one file: look up every non-stdlib, non-local import.
 * Declared packages are checked too — a hallucinated name can be in
 * requirements.txt as easily as in the code.
 */
export async function checkRegistry(languageKey: string, text: string, ctx: DepContext, fetchImpl?: FetchLike, now = Date.now()): Promise<Finding[]> {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const ref of extractImports(languageKey, text)) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    const cls = classifyImport(ref, ctx);
    if (cls === 'stdlib' || cls === 'local') continue;
    // For mapped Python imports look up the real distribution name.
    const dist = ref.ecosystem === 'pypi' ? (PY_IMPORT_TO_DIST[ref.name]?.[0] ?? ref.name) : ref.name;
    if (ref.ecosystem === 'pypi' && ref.name === 'google') continue;   // namespace package, many dists
    const info = await lookupPackage(ref.ecosystem, dist, fetchImpl);
    const at = { line: ref.line, col: ref.col, endLine: ref.line, endCol: ref.col + ref.name.length };
    if (!info.exists) {
      out.push({ ...at, ruleId: 'KP302', severity: 'critical', debtMinutes: 30,
        message: `'${dist}' does not exist on ${ref.ecosystem === 'pypi' ? 'PyPI' : 'npm'} — very likely a hallucinated package. Do NOT create or install it; find the real library.` });
    } else if (info.created) {
      const days = Math.floor((now - Date.parse(info.created)) / 86_400_000);
      if (days >= 0 && days < NEW_PACKAGE_DAYS)
        out.push({ ...at, ruleId: 'KP303', severity: 'major', debtMinutes: 15,
          message: `'${dist}' was first published ${days} day${days === 1 ? '' : 's'} ago. Check its author, repository and downloads before trusting it.` });
    }
  }
  return out;
}

/** For tests: forget cached registry answers. */
export function clearRegistryCache(): void { registryCache.clear(); }
