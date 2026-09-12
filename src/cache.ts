/* =============================================================================
 * KASAUTI — cache.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Stores each file's FileAnalysis on disk, keyed by SHA-256 of
 *        (engine version + language + file content).
 * WHY:   Parsing is the expensive part. With the cache, re-opening a project
 *        re-scores thousands of files in seconds (SPEC §B7: warm scan < 3 s).
 *        Keyed by CONTENT (not path or mtime): renames and git checkouts that
 *        restore old content are free, and a stale entry is impossible.
 *        Lives in VS Code's per-workspace storage, never inside the repo (§B5).
 *        FORMAT: [uint32 jsonLength][utf8 JSON metadata][tokenIds][tokenLines]
 *        [lineLengths] — the three typed arrays are copied raw, so restoring a
 *        cached file costs one read and no parsing of million-element arrays.
 *        (Measured: base64+JSON made a 5,000-file warm scan ~2x slower.)
 * FLOW:  controller.ts: hash = cache.key(text) -> cache.get(hash) ?? analyze ->
 *        cache.put(hash, analysis)
 * ========================================================================== */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ENGINE_VERSION } from './engine/analyzer';
import type { FileAnalysis } from './engine/types';

type Meta = Omit<FileAnalysis, 'tokenIds' | 'tokenLines' | 'lineLengths'> & { n: [number, number, number] };

/** Copy a Buffer slice into its own aligned Uint32Array. */
function u32(buf: Buffer, offset: number, count: number): Uint32Array {
  const out = new Uint32Array(count);
  Buffer.from(out.buffer).set(buf.subarray(offset, offset + count * 4));
  return out;
}

export class AnalysisCache {
  /** @param dir folder for cache files; undefined disables caching */
  constructor(private readonly dir: string | undefined) {
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  key(languageKey: string, text: string): string {
    return crypto.createHash('sha256').update(ENGINE_VERSION).update('\0').update(languageKey).update('\0').update(text).digest('hex');
  }

  private file(hash: string): string {
    // Two-level fan-out keeps directories small on big workspaces.
    return path.join(this.dir!, hash.slice(0, 2), hash + '.json');
  }

  async get(hash: string): Promise<FileAnalysis | undefined> {
    if (!this.dir) return undefined;
    try {
      const buf = await fs.promises.readFile(this.file(hash));
      const jsonLen = buf.readUInt32LE(0);
      const meta = JSON.parse(buf.toString('utf8', 4, 4 + jsonLen)) as Meta;
      if (meta.engineVersion !== ENGINE_VERSION) return undefined;
      const [a, b, c] = meta.n;
      let off = 4 + jsonLen;
      const tokenIds = u32(buf, off, a); off += a * 4;
      const tokenLines = u32(buf, off, b); off += b * 4;
      const lineLengths = u32(buf, off, c);
      return { ...meta, tokenIds, tokenLines, lineLengths };
    } catch { return undefined; }       // missing or corrupt -> just re-analyze
  }

  async put(hash: string, a: FileAnalysis): Promise<void> {
    if (!this.dir) return;
    const f = this.file(hash);
    try {
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      const { tokenIds, tokenLines, lineLengths, ...rest } = a;
      const meta: Meta = { ...rest, n: [tokenIds.length, tokenLines.length, lineLengths.length] };
      const json = Buffer.from(JSON.stringify(meta), 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(json.length, 0);
      const raw = (x: Uint32Array) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);
      // Write to a temp file then rename: a crash can never leave half a file.
      const tmp = f + '.' + process.pid + '.tmp';
      await fs.promises.writeFile(tmp, Buffer.concat([header, json, raw(tokenIds), raw(tokenLines), raw(lineLengths)]));
      await fs.promises.rename(tmp, f);
    } catch { /* cache is best-effort */ }
  }

  async clear(): Promise<void> {
    if (!this.dir) return;
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    await fs.promises.mkdir(this.dir, { recursive: true });
  }
}
