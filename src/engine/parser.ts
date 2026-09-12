/* =============================================================================
 * KASAUTI — engine/parser.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Owns the web-tree-sitter runtime inside one worker thread: initializes
 *        the WASM runtime once, loads each language grammar lazily (only when a
 *        file of that language is first seen), and remembers grammars that fail.
 * WHY:   - Lazy loading keeps activation fast (SPEC §B7: < 300 ms).
 *        - The M1 spike (11 Sep 2026) proved a failing grammar can corrupt the
 *          WASM runtime for everything after it. So on ANY grammar failure we
 *          report it upward and the host recycles this worker (SPEC §B9).
 *        - Version pinned to web-tree-sitter 0.25.10: 0.27 loads none of the
 *          prebuilt grammars; 0.25.10 loads 24 of 25 (Elm is ABI 12).
 *        - Lua comes from @tree-sitter-grammars/tree-sitter-lua@0.4.1, NOT from
 *          tree-sitter-wasms: the older build returns broken trees on every
 *          parse after the first (verified by the repeated-parse test).
 * FLOW:  worker.ts -> ParserService.parse(key, text) -> Tree -> analyzer.ts
 * ========================================================================== */

import * as fs from 'fs';
import * as path from 'path';
import { Parser, Language, Tree } from 'web-tree-sitter';

export class GrammarError extends Error {
  constructor(public readonly grammar: string, message: string) { super(message); }
}

export class ParserService {
  private ready: Promise<void> | undefined;
  private readonly languages = new Map<string, Language>();
  private readonly parsers = new Map<string, Parser>();
  private readonly broken = new Set<string>();

  /** @param wasmDir folder containing tree-sitter.wasm and tree-sitter-<lang>.wasm */
  constructor(private readonly wasmDir: string) {}

  /** Initialize the WASM runtime exactly once (idempotent). */
  init(): Promise<void> {
    this.ready ??= Parser.init({
      // WHY: bundlers move files around; point the runtime at our copy.
      locateFile: (name: string) => path.join(this.wasmDir, name),
    });
    return this.ready;
  }

  isBroken(key: string): boolean { return this.broken.has(key); }

  /** Get (or lazily create) a parser for a grammar key like 'python'. */
  private async parserFor(key: string): Promise<Parser> {
    await this.init();
    const cached = this.parsers.get(key);
    if (cached) return cached;
    if (this.broken.has(key)) throw new GrammarError(key, `grammar ${key} previously failed`);
    try {
      const bytes = fs.readFileSync(path.join(this.wasmDir, `tree-sitter-${key}.wasm`));
      const lang = await Language.load(bytes);
      const parser = new Parser();
      parser.setLanguage(lang);
      this.languages.set(key, lang);
      this.parsers.set(key, parser);
      return parser;
    } catch (e) {
      this.broken.add(key);
      throw new GrammarError(key, `failed to load grammar ${key}: ${String((e as Error)?.message ?? e)}`);
    }
  }

  /** Parse text. Caller MUST call tree.delete() (WASM memory is manual). */
  async parse(key: string, text: string): Promise<Tree> {
    const parser = await this.parserFor(key);
    try {
      const tree = parser.parse(text);
      if (!tree) throw new Error('parser returned no tree');
      return tree;
    } catch (e) {
      this.broken.add(key);
      throw new GrammarError(key, `parse failed for ${key}: ${String((e as Error)?.message ?? e)}`);
    }
  }
}
