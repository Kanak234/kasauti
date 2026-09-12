/* =============================================================================
 * KASAUTI — scanner.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Finds every analyzable file in all workspace folders and reads it.
 * WHY:   SPEC FR-09: respect .gitignore (including nested ones) and skip
 *        dependency/build folders by default; SPEC §A9: skip binary and
 *        oversized files; never follow symlinks into loops.
 *        Uses vscode.workspace.fs so it also works over SSH/WSL/containers.
 * FLOW:  controller.scanWorkspace() -> findFiles() -> readSource() per file
 *        -> worker pool / cache.
 * ========================================================================== */

import * as vscode from 'vscode';
import ignore, { Ignore } from 'ignore';
import { allKnownExtensions, detectLanguage } from './engine/languages';
import type { KasautiConfig } from './config';

export interface SourceFile {
  uri: vscode.Uri;
  relPath: string;         // '/'-separated; prefixed with folder name in multi-root
  languageKey: string;
}

/** Folders that are practically never hand-written source. */
export const DEFAULT_EXCLUDES = ['node_modules', '.git', 'venv', '.venv', 'env', '__pycache__', 'dist', 'build',
  'out', 'target', 'bin', 'obj', '.next', '.nuxt', 'vendor', 'Pods', '.gradle', '.idea', '.vscode-test',
  'coverage', '.dart_tool', '_build', 'deps', '.mypy_cache', '.pytest_cache', '.tox', 'site-packages', '.terraform'];

const SPECIAL_FILES = ['Makefile', 'GNUmakefile', 'Dockerfile', 'CMakeLists.txt', 'Rakefile', 'Gemfile', 'Jenkinsfile'];

/** Relative path used everywhere in the UI. */
export function relPathOf(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  // In multi-root workspaces asRelativePath already includes the folder name.
  return multi && !rel.startsWith(folder.name + '/') ? `${folder.name}/${rel}` : rel;
}

/** All .gitignore rules of one workspace folder, applied per directory. */
class GitIgnores {
  private readonly rules: Array<{ base: string; ig: Ignore }> = [];
  static async load(folder: vscode.WorkspaceFolder): Promise<GitIgnores> {
    const gi = new GitIgnores();
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/.gitignore'),
      `**/{${DEFAULT_EXCLUDES.join(',')}}/**`, 2000);
    for (const uri of found) {
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
        const relInFolder = rel.startsWith(folder.name + '/') && (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? rel.slice(folder.name.length + 1) : rel;
        const base = relInFolder.includes('/') ? relInFolder.slice(0, relInFolder.lastIndexOf('/') + 1) : '';
        gi.rules.push({ base, ig: ignore().add(text) });
      } catch { /* unreadable .gitignore: ignore it */ }
    }
    return gi;
  }
  /** @param relInFolder path relative to the workspace folder */
  ignores(relInFolder: string): boolean {
    for (const r of this.rules) {
      if (!relInFolder.startsWith(r.base)) continue;
      const sub = relInFolder.slice(r.base.length);
      if (sub && r.ig.ignores(sub)) return true;
    }
    return false;
  }
}

/** Minimal glob -> RegExp (supports **, *, ?, {a,b}) for user `exclude`
 *  patterns, so file-watcher events can be filtered like the scan was. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Filter remembered from the last scan (gitignore + excludes), used to
 *  decide whether a watcher event or an opened document is "workspace code". */
export class ExcludeFilter {
  constructor(private readonly ignores: Map<string, GitIgnores>, private readonly globs: RegExp[]) {}
  static empty(): ExcludeFilter { return new ExcludeFilter(new Map(), []); }
  excludes(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return true;
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    if (rel.split('/').some((seg) => DEFAULT_EXCLUDES.includes(seg))) return true;
    if (this.globs.some((g) => g.test(rel))) return true;
    return this.ignores.get(folder.uri.toString())?.ignores(rel) ?? false;
  }
}

/** Discover every analyzable file. Cancellation-aware. */
export async function findSourceFiles(cfg: KasautiConfig, token?: vscode.CancellationToken): Promise<{ files: SourceFile[]; filter: ExcludeFilter }> {
  const ignoresByFolder = new Map<string, GitIgnores>();
  const exts = [...new Set([...allKnownExtensions(), ...cfg.extraTier2Extensions])].map((e) => e.replace(/^\./, ''));
  const include = `{**/*.{${exts.join(',')}},**/{${SPECIAL_FILES.join(',')}}}`;
  const exclude = `{**/{${DEFAULT_EXCLUDES.join(',')}}/**${cfg.exclude.length ? ',' + cfg.exclude.join(',') : ''}}`;
  const out: SourceFile[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (token?.isCancellationRequested) break;
    const [uris, gi] = await Promise.all([
      vscode.workspace.findFiles(new vscode.RelativePattern(folder, include), new vscode.RelativePattern(folder, exclude), undefined, token),
      GitIgnores.load(folder),
    ]);
    ignoresByFolder.set(folder.uri.toString(), gi);
    for (const uri of uris) {
      const languageKey = detectLanguage(uri.path, cfg.extraTier2Extensions);
      if (!languageKey) continue;
      const inFolder = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      const relInFolder = (vscode.workspace.workspaceFolders!.length > 1 && inFolder.startsWith(folder.name + '/')) ? inFolder.slice(folder.name.length + 1) : inFolder;
      if (gi.ignores(relInFolder)) continue;
      out.push({ uri, relPath: relPathOf(uri) ?? relInFolder, languageKey });
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files: out, filter: new ExcludeFilter(ignoresByFolder, cfg.exclude.map(globToRegExp)) };
}

export type ReadResult = { text: string } | { skip: string; lines?: number };

/** Read a file as UTF-8 text, or explain why it is skipped (Tier 3). */
export async function readSource(uri: vscode.Uri, maxKB: number): Promise<ReadResult> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.SymbolicLink) return { skip: 'symlink' };
    if (stat.size > maxKB * 1024) return { skip: 'too large' };
    const bytes = await vscode.workspace.fs.readFile(uri);
    // Binary: a NUL byte in the first 8 KB (the heuristic git itself uses).
    const probe = bytes.subarray(0, 8192);
    if (probe.includes(0)) return { skip: 'binary' };
    return { text: new TextDecoder('utf-8').decode(bytes) };
  } catch (e) {
    return { skip: `unreadable (${(e as Error).message})` };
  }
}
