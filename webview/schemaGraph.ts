/* =============================================================================
 * KASAUTI — webview/schemaGraph.ts   (v2.1 Code Map — pure logic, no DOM)
 * -----------------------------------------------------------------------------
 * WHAT:  Turns the file list into a NeuralSchema-style graph:
 *          nodes  project root · folders · files · (optionally) functions
 *          edges  'tree'   folder → folder/file, file → function
 *                 'import' file → another project file it imports
 *        plus the crawl order (BFS / DFS) the animation reveals nodes in.
 * WHY:   Kanak's feedback: the 3D pyramid did not read well. A node-link map
 *        shows what a pyramid cannot — which files DEPEND on which — and a
 *        bad file that everything imports is visibly more dangerous than an
 *        isolated one. Kept free of DOM/canvas so it is unit-tested in Node.
 * FLOW:  webview/schema.ts calls buildGraph(files, opts) on every update and
 *        crawlOrder(graph, mode) when the crawl (re)starts.
 * ========================================================================== */

import type { UiFile } from '../src/snapshot';
import type { Grade } from '../src/engine/types';

export type NodeKind = 'root' | 'dir' | 'file' | 'fn';
export interface GNode {
  id: string;
  kind: NodeKind;
  label: string;
  parent?: string;
  /** file key (files and functions) — used to open / select */
  key?: string;
  line?: number;
  grade?: Grade;
  /** visual radius in world units */
  r: number;
  /** [performance, security, AI-risk] finding counts → coloured rings */
  kp?: [number, number, number];
  partial?: boolean;
  /** how many project files import this one (fan-in) */
  fanIn: number;
}
export interface GEdge { a: string; b: string; kind: 'tree' | 'import' }
export interface Graph { nodes: Map<string, GNode>; edges: GEdge[]; adj: Map<string, string[]> }

export interface BuildOptions {
  /** show every function node (else only for `expanded` files) */
  functions: boolean;
  expanded: Set<string>;
  /** soft cap: above it, function nodes are dropped first */
  maxNodes?: number;
}

const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const stripExt = (p: string) => p.replace(/\.[^./]+$/, '');

/* ---------------------------------------------------------------------------
 * Import resolution: specifier -> project file path, or nothing (external).
 * Exact rules per language; anything unresolvable is simply not drawn
 * (a missing edge is better than a wrong one).
 * ------------------------------------------------------------------------- */
export function resolveImports(files: Array<Pick<UiFile, 'key' | 'path' | 'lang' | 'imp'>>): Array<[string, string]> {
  const byPath = new Map(files.map((f) => [f.path, f.key]));
  const byNoExt = new Map<string, string[]>();
  for (const f of files) { const k = stripExt(f.path); byNoExt.set(k, [...(byNoExt.get(k) ?? []), f.key]); }
  // Suffix index for "dotted" languages (Java/Python packages may sit under src/ or app/).
  const bySuffix = (suffix: string) => files.filter((f) => stripExt(f.path) === suffix || stripExt(f.path).endsWith('/' + suffix)).map((f) => f.key);

  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  const add = (from: string, to: string | undefined) => {
    if (!to || to === from) return;
    const k = from + '>' + to;
    if (!seen.has(k)) { seen.add(k); out.push([from, to]); }
  };
  for (const f of files) {
    if (!f.imp) continue;
    const dir = dirOf(f.path);
    const lang = f.lang.toLowerCase();
    for (const spec of f.imp) {
      if (lang.startsWith('python') || lang.includes('notebook')) {
        // `.x` / `..x.y` relative; `a.b` absolute (try as a path suffix).
        const dots = /^\.*/.exec(spec)![0].length;
        const rest = spec.slice(dots).replace(/\./g, '/');
        let base: string;
        if (dots) { let d = dir; for (let i = 1; i < dots; i++) d = dirOf(d); base = d ? (rest ? `${d}/${rest}` : d) : rest; }
        else base = rest;
        const cands = [base, `${base}/__init__`];
        const hit = cands.map((c) => byNoExt.get(c)?.[0]).find(Boolean) ?? (dots ? undefined : bySuffix(base)[0] ?? bySuffix(`${base}/__init__`)[0]);
        add(f.key, hit);
      } else if (/javascript|typescript|tsx/.test(lang)) {
        if (!spec.startsWith('.')) continue;                       // packages are not project files
        const parts = (dir ? dir.split('/') : []);
        for (const seg of spec.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.' && seg) parts.push(seg); }
        const p = parts.join('/');
        const hit = byPath.get(p) ?? byNoExt.get(stripExt(p))?.[0] ?? byNoExt.get(p)?.[0] ?? byNoExt.get(`${p}/index`)?.[0];
        add(f.key, hit);
      } else if (/java|kotlin|scala/.test(lang)) {
        add(f.key, bySuffix(spec.replace(/\./g, '/'))[0]);
      } else if (/^(c|c\+\+|objective-c)$/.test(lang) || /\.(c|cc|cpp|h|hpp)$/.test(f.path)) {
        const rel = dir ? `${dir}/${spec}` : spec;
        add(f.key, byPath.get(rel.replace(/\/\.\//g, '/')) ?? files.find((g) => g.path.endsWith('/' + spec) || g.path === spec)?.key);
      } else if (lang === 'go') {
        // Go imports a package (folder): link to every file of that folder is noisy, so link to the first.
        const hit = files.find((g) => dirOf(g.path) === spec || dirOf(g.path).endsWith('/' + spec));
        add(f.key, hit?.key);
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Graph
 * ------------------------------------------------------------------------- */
export function buildGraph(files: UiFile[], opt: BuildOptions): Graph {
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const link = (a: string, b: string, kind: GEdge['kind']) => edges.push({ a, b, kind });
  nodes.set('root', { id: 'root', kind: 'root', label: 'project', r: 9, fanIn: 0 });

  // Folders: one node per directory level, chained to the root.
  const ensureDir = (d: string): string => {
    if (!d) return 'root';
    const id = 'dir:' + d;
    if (!nodes.has(id)) {
      const parent = ensureDir(dirOf(d));
      nodes.set(id, { id, kind: 'dir', label: d.split('/').pop()! + '/', parent, r: 5, fanIn: 0 });
      link(parent, id, 'tree');
    }
    return id;
  };

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const fnBudget = Math.max(0, (opt.maxNodes ?? 4000) - sorted.length * 1.3);
  let fnCount = 0;
  for (const f of sorted) {
    const parent = ensureDir(dirOf(f.path));
    const id = 'file:' + f.key;
    nodes.set(id, { id, kind: 'file', label: f.path.split('/').pop()!, parent, key: f.key, grade: f.grade,
      r: 3 + Math.min(9, Math.sqrt(Math.max(1, f.sloc)) / 3), kp: f.kp, partial: f.tier === 2, fanIn: 0 });
    link(parent, id, 'tree');
    if ((opt.functions || opt.expanded.has(f.key)) && f.fns) {
      for (const fn of f.fns) {
        if (fnCount >= fnBudget && !opt.expanded.has(f.key)) break;
        const fid = `fn:${f.key}#${fn.line}`;
        nodes.set(fid, { id: fid, kind: 'fn', label: fn.name + '()', parent: id, key: f.key, line: fn.line, grade: fn.grade, r: 1.6 + Math.min(3, fn.cc / 6), fanIn: 0 });
        link(id, fid, 'tree');
        fnCount++;
      }
    }
  }
  for (const [a, b] of resolveImports(sorted)) {
    link('file:' + a, 'file:' + b, 'import');
    const t = nodes.get('file:' + b);
    if (t) t.fanIn++;
  }
  // Heavily imported files are hubs: draw them a little larger.
  for (const n of nodes.values()) if (n.kind === 'file' && n.fanIn) n.r += Math.min(5, Math.log2(1 + n.fanIn) * 1.5);

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.a, [...(adj.get(e.a) ?? []), e.b]);
    adj.set(e.b, [...(adj.get(e.b) ?? []), e.a]);
  }
  return { nodes, edges, adj };
}

/** Order in which a crawler starting at the project root discovers nodes,
 *  with the edge it came through (for the "imports → x" log and the trail). */
export function crawlOrder(g: Graph, mode: 'bfs' | 'dfs'): Array<{ id: string; via?: string; depth: number }> {
  const out: Array<{ id: string; via?: string; depth: number }> = [];
  const seen = new Set<string>(['root']);
  const frontier: Array<{ id: string; via?: string; depth: number }> = [{ id: 'root', depth: 0 }];
  while (frontier.length) {
    const cur = mode === 'bfs' ? frontier.shift()! : frontier.pop()!;
    out.push(cur);
    const next = [...(g.adj.get(cur.id) ?? [])].sort();
    // DFS pops from the end: push in reverse so children are visited in name order.
    for (const n of mode === 'dfs' ? next.reverse() : next) {
      if (seen.has(n)) continue;
      seen.add(n);
      frontier.push({ id: n, via: cur.id, depth: cur.depth + 1 });
    }
  }
  // Nodes unreachable from the root (cannot happen with tree edges, but be safe).
  for (const id of g.nodes.keys()) if (!seen.has(id)) out.push({ id, depth: 0 });
  return out;
}
