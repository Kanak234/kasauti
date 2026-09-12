/* =============================================================================
 * KASAUTI — engine/duplication.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Finds copy-pasted code across the whole workspace (rule CQ007), and
 *        keeps the answer up to date incrementally as single files change.
 * WHY:   Duplication is a cross-file property, so it cannot be computed inside
 *        a per-file worker. It must also be cheap enough to update on every
 *        keystroke pause (live mode).
 * HOW:   1. Every file's token ids are cut into k-grams (K tokens) and hashed.
 *        2. WINNOWING (Schleimer, Wilkerson & Aiken, SIGMOD 2003) keeps the
 *           minimum hash of each window of W k-grams. It guarantees: any shared
 *           run of >= W + K - 1 tokens (= the duplication threshold) shares at
 *           least one kept fingerprint — while storing only ~2/(W+1) of them.
 *        3. SEED-AND-EXTEND: a shared fingerprint is only a *seed*. We compare
 *           actual token ids backwards and forwards to get the exact clone
 *           length, so hash collisions can never create a false finding.
 * FLOW:  store.ts -> setFile()/removeFile() -> returns affected files ->
 *        store.ts calls duplicatesFor(path) for each -> CQ007 findings.
 * ========================================================================== */

export interface DupBlock {
  startLine: number;       // 0-based, in this file
  endLine: number;
  tokens: number;
  partnerPath: string;     // where the other copy is
  partnerLine: number;
}

interface FileEntry {
  ids: Uint32Array;
  lines: Uint32Array;
  fps: Array<[number, number]>;   // [fingerprint, token position]
}

const B1 = 0x01000193, B2 = 0x5bd1e995;       // two independent hash bases
/** Max places one fingerprint is tracked in (see setFile). */
const MAX_OCCURRENCES = 64;
const EMPTY: Set<string> = new Set();

export class DuplicationIndex {
  private readonly files = new Map<string, FileEntry>();
  private readonly index = new Map<number, Array<{ path: string; pos: number }>>();
  private readonly cache = new Map<string, DupBlock[]>();
  private K: number;
  private W: number;

  constructor(private minTokens: number) {
    // K-gram size and window derived from the threshold T: W + K - 1 = T.
    this.K = Math.max(5, Math.min(20, Math.floor(minTokens / 2)));
    this.W = Math.max(1, minTokens - this.K + 1);
  }

  get fileCount(): number { return this.files.size; }

  /**
   * Add or replace a file. Returns every file whose duplicates may change.
   * @param bulk during a full scan: skip building the affected-set. Boilerplate
   *   shared by thousands of files makes a fingerprint's occurrence list huge,
   *   and walking it on every insert is O(n^2) — measured at 5.8 s for a
   *   5,000-file workspace. The scan re-evaluates everything at the end anyway.
   */
  setFile(path: string, ids: Uint32Array, lines: Uint32Array, bulk = false): Set<string> {
    const affected = this.removeInternal(path, bulk);
    const fps = this.fingerprints(ids);
    this.files.set(path, { ids, lines, fps });
    for (const [h, pos] of fps) {
      let list = this.index.get(h);
      if (!list) { list = []; this.index.set(h, list); }
      if (!bulk) for (const o of list) affected.add(o.path);
      // Cap: a fingerprint in more than MAX_OCCURRENCES places is boilerplate
      // (licence headers, generated preambles). Keeping more finds no new
      // duplication, it only slows every later insert down.
      if (list.length < MAX_OCCURRENCES) list.push({ path, pos });
    }
    if (bulk) { this.cache.clear(); return EMPTY; }
    affected.add(path);
    for (const p of affected) this.cache.delete(p);
    return affected;
  }

  /** Remove a file. Returns files whose duplicates may change. */
  removeFile(path: string): Set<string> {
    const affected = this.removeInternal(path);
    for (const p of affected) this.cache.delete(p);
    return affected;
  }

  private removeInternal(path: string, bulk = false): Set<string> {
    const affected = new Set<string>();
    const old = this.files.get(path);
    if (!old) return affected;
    for (const [h] of old.fps) {
      const list = this.index.get(h);
      if (!list) continue;
      const kept = list.filter((o) => o.path !== path);
      if (!bulk) for (const o of kept) affected.add(o.path);
      if (kept.length) this.index.set(h, kept); else this.index.delete(h);
    }
    this.files.delete(path);
    this.cache.delete(path);
    return affected;
  }

  /** Duplicated blocks of one file (cached until the file or a partner changes). */
  duplicatesFor(path: string): DupBlock[] {
    const hit = this.cache.get(path);
    if (hit) return hit;
    const f = this.files.get(path);
    if (!f) return [];
    const found: Array<{ s: number; e: number; partner: string; ps: number }> = [];
    const covered = (pos: number) => found.some((x) => pos >= x.s && pos < x.e);

    for (const [h, pos] of f.fps) {
      if (covered(pos)) continue;
      const occ = this.index.get(h);
      if (!occ || occ.length < 2) continue;
      for (const o of occ) {
        if (o.path === path && o.pos === pos) continue;
        const g = this.files.get(o.path);
        if (!g) continue;
        // Verify the seed is a real match (not a hash collision).
        let ok = true;
        for (let k = 0; k < this.K; k++) if (f.ids[pos + k] !== g.ids[o.pos + k]) { ok = false; break; }
        if (!ok) continue;
        // Extend backwards and forwards on exact token equality.
        let a = pos, b = o.pos;
        while (a > 0 && b > 0 && f.ids[a - 1] === g.ids[b - 1]) { a--; b--; }
        let e1 = pos, e2 = o.pos;
        while (e1 < f.ids.length && e2 < g.ids.length && f.ids[e1] === g.ids[e2]) { e1++; e2++; }
        const len = e1 - a;
        // Same file: the two copies must not overlap (a repeated pattern
        // like "x++; x++; x++;" would otherwise match itself shifted).
        if (o.path === path && b < e1 && a < b + len) continue;
        if (len < this.minTokens) continue;
        found.push({ s: a, e: e1, partner: o.path, ps: b });
        break;                    // one partner is enough to report the block
      }
    }

    // Merge overlapping blocks and convert token positions to lines.
    found.sort((x, y) => x.s - y.s);
    const merged: typeof found = [];
    for (const x of found) {
      const last = merged[merged.length - 1];
      if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
      else merged.push({ ...x });
    }
    const blocks = merged.map((x) => ({
      startLine: f.lines[x.s], endLine: f.lines[x.e - 1], tokens: x.e - x.s,
      partnerPath: x.partner, partnerLine: this.files.get(x.partner)!.lines[x.ps],
    }));
    this.cache.set(path, blocks);
    return blocks;
  }

  /** Winnowed fingerprints: [53-bit hash, token position of its k-gram]. */
  private fingerprints(ids: Uint32Array): Array<[number, number]> {
    const K = this.K, W = this.W, n = ids.length - K + 1;
    if (n <= 0) return [];
    // Rolling polynomial hashes (mod 2^32) with two bases -> combined key.
    let p1 = 1, p2 = 1;
    for (let i = 0; i < K; i++) { p1 = Math.imul(p1, B1) >>> 0; p2 = Math.imul(p2, B2) >>> 0; }
    const hashes = new Float64Array(n);
    let h1 = 0, h2 = 0;
    for (let i = 0; i < ids.length; i++) {
      h1 = (Math.imul(h1, B1) + ids[i]) >>> 0;
      h2 = (Math.imul(h2, B2) + ids[i]) >>> 0;
      if (i >= K) {
        h1 = (h1 - Math.imul(ids[i - K], p1)) >>> 0;
        h2 = (h2 - Math.imul(ids[i - K], p2)) >>> 0;
      }
      if (i >= K - 1) hashes[i - K + 1] = h1 * 2097152 + (h2 >>> 11);
    }
    // Winnowing with a monotonic deque: rightmost minimum of each window.
    // Monotonic deque in a typed ring buffer: Array.shift() is O(n) and this
    // loop runs once per token in the workspace.
    const out: Array<[number, number]> = [];
    const dq = new Int32Array(n);
    let head = 0, tail = 0, lastPicked = -1;
    for (let i = 0; i < n; i++) {
      while (tail > head && hashes[dq[tail - 1]] >= hashes[i]) tail--;
      dq[tail++] = i;
      if (dq[head] <= i - W) head++;
      if (i >= W - 1 || i === n - 1) {
        const m = dq[head];
        if (m !== lastPicked) { out.push([hashes[m], m]); lastPicked = m; }
      }
    }
    return out;
  }
}
