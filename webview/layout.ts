/* =============================================================================
 * KASAUTI — webview/layout.ts   (rewritten in v0.2.0)
 * -----------------------------------------------------------------------------
 * WHAT:  Pure function: a list of files -> the position and size of every
 *        block and every floor of the pyramid.
 * WHY:   Kept free of Three.js and the DOM so the geometry can be unit-tested
 *        in Node — which is the only way it gets verified at all, since this
 *        build environment has no GPU.
 *
 * WHY IT WAS REWRITTEN (v0.1.0 bug, reported from a real editor):
 *   the pyramid rendered as "one long stick". Measured causes:
 *     1. blocks were 5-6.5x taller than wide  -> every file was a spike
 *     2. floors shrank only ~17% per level    -> no visible taper
 *     3. total height ~= base width           -> a tower silhouette
 *     4. a one-folder project produced ONE floor -> no steps at all
 *   All four are now structural invariants, each locked by a test:
 *     A. a block is never taller than MAX_BLOCK_ASPECT x its own width
 *     B. each floor is at least MIN_TAPER cells wider per side than the one above
 *     C. total height <= MAX_HEIGHT_RATIO x base width (heights scale down if needed)
 *     D. there are always at least MIN_FLOORS floors when the files allow it
 *
 * FLOW:  main.ts calls layoutPyramid(files) after every update and writes the
 *        result into InstancedMesh matrices.
 * ========================================================================== */

export interface LayoutInput {
  key: string;
  path: string;
  sloc: number;
  value: number;       // the metric mapped to height (debt, complexity, ...)
}

export interface BlockPlacement {
  key: string;
  x: number; z: number;   // centre on the floor
  y: number;              // floor top (block base)
  w: number;              // footprint (square)
  h: number;              // height
  floor: number;          // index into floors[]
}

export interface FloorPlacement {
  /** Folder depth, or the depth of the group when a depth was subdivided. */
  depth: number;
  /** Human label for the tier, e.g. "src/engine" or "depth 2". */
  label: string;
  y: number;              // slab bottom
  size: number;           // slab side length
  thickness: number;
  files: number;
}

export interface PyramidLayout { blocks: BlockPlacement[]; floors: FloorPlacement[]; width: number; height: number }

/* ---- geometry constants --------------------------------------------------
 * Tuned so the silhouette reads as a stepped pyramid (a kasauti), not a tower.
 * Every one of these is exercised by test/webview.test.ts.
 * ------------------------------------------------------------------------- */
const CELL = 1;                  // grid pitch on a floor
const PAD = 0.55;                // margin from the outermost block to the slab edge
const SHRINK = 0.74;             // each floor is this fraction of the one below
const MIN_SLAB = 1.8;            // a floor never shrinks below this
const SLAB_MAX = 0.26;           // slab thickness (thinner on small pyramids)
const MIN_H = 0.07;
const MIN_W = 0.62, MAX_W = 0.96; // block footprint, as a fraction of the cell
const MAX_CELL = 1.35;           // widest a grid cell may stretch when filling a slab
const MAX_BLOCK_ASPECT = 1.6;    // invariant A: a block is a tile, never a spike
const MAX_HEIGHT_RATIO = 0.5;    // invariant C: height <= this x base width
const STEP_RATIO = 0.105;        // floor pitch as a fraction of the base width
const MIN_PITCH = 0.85, MAX_PITCH = 2.2;
const CLEARANCE = 0.14;          // share of the pitch left clear above the tallest block
const MIN_FLOORS = 3;            // invariant D
const MAX_FLOORS = 6;            // deep trees merge, so it never becomes a tower

/**
 * Log-scaled height in 0..1: one huge outlier must not flatten everything else.
 *
 * v0.2.0 fix: when NOTHING has a value — a clean workspace with zero technical
 * debt, which is the state the tool is supposed to reward — every block used to
 * come out at zero height and the pyramid rendered as a bare plate. A project
 * with no debt should look like a well-built pyramid, not like an empty one.
 * So an all-zero workspace gets a uniform, modest block height instead of none.
 */
export const FLAT_FRACTION = 0.55;

export function heightFraction(value: number, max: number): number {
  if (max <= 0) return FLAT_FRACTION;     // nothing to compare: show even blocks
  if (value <= 0) return 0;
  return Math.log1p(value) / Math.log1p(max);
}

const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v); else m.set(k, [v]);
}

/**
 * Decide the tiers. Normally one tier per folder depth (root at the bottom).
 * Two corrections keep the shape a pyramid on real projects:
 *   - too few tiers: the biggest tier is split by directory, repeatedly, until
 *     there are MIN_FLOORS. A flat project therefore still gets steps, and the
 *     steps still mean something ("these files live together").
 *   - too many tiers: the deepest ones merge, so a deeply nested repo does not
 *     turn into a ten-storey tower.
 */
function makeTiers(files: LayoutInput[]): Array<{ label: string; files: LayoutInput[]; depth: number }> {
  const byDepth = new Map<number, LayoutInput[]>();
  for (const f of files) push(byDepth, f.path.split('/').length - 1, f);
  let tiers = [...byDepth.entries()].sort((a, b) => a[0] - b[0])
    .map(([depth, list]) => ({ depth, label: depth === 0 ? 'root' : `depth ${depth}`, files: list }));

  while (tiers.length > MAX_FLOORS) {
    const last = tiers.pop()!;
    const prev = tiers[tiers.length - 1];
    prev.files = prev.files.concat(last.files);
    prev.label = `${prev.label}+`;
  }

  while (tiers.length < MIN_FLOORS) {
    let bi = -1, best = 1;
    for (let i = 0; i < tiers.length; i++) {
      const groups = new Set(tiers[i].files.map((f) => dirOf(f.path))).size;
      if (groups > 1 && tiers[i].files.length > best) { best = tiers[i].files.length; bi = i; }
    }
    if (bi < 0) {
      // Every file lives in the same directory (very common in small student
      // projects). Fall back to size bands: the biggest files form the base,
      // which is both a real property of the code and a proper pyramid.
      const biggest = tiers.reduce((a, b) => (b.files.length > a.files.length ? b : a));
      if (biggest.files.length < MIN_FLOORS) break;      // too few files to band
      const sorted = [...biggest.files].sort((a, b) => b.sloc - a.sloc);
      const want = Math.min(MIN_FLOORS - tiers.length + 1, sorted.length);
      // Balanced split. `ceil(n / want)` leaves the last band empty for cases
      // like 4 files in 3 bands (2,2,0) and the pyramid loses a step; this
      // spreads the remainder instead, giving (2,1,1).
      const base = Math.floor(sorted.length / want);
      const extra = sorted.length % want;
      const names = ['largest files', 'mid-size files', 'smallest files'];
      let cut = 0;
      const bands = Array.from({ length: want }, (_, i) => {
        const take = base + (i < extra ? 1 : 0);
        const slice = sorted.slice(cut, cut + take);
        cut += take;
        return { depth: biggest.depth, label: want === 3 ? names[i] : `size band ${i + 1}`, files: slice };
      }).filter((b) => b.files.length > 0);
      if (bands.length < 2) break;
      tiers.splice(tiers.indexOf(biggest), 1, ...bands);
      continue;
    }
    const target = tiers[bi];
    const groups = new Map<string, LayoutInput[]>();
    for (const f of target.files) push(groups, dirOf(f.path), f);
    // Biggest group stays lowest, so the tier keeps tapering upward.
    const parts = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([dir, list]) => ({ depth: target.depth, label: dir || 'root', files: list }));
    tiers.splice(bi, 1, ...parts);
  }
  return tiers;
}

export function layoutPyramid(files: LayoutInput[]): PyramidLayout {
  if (!files.length) return { blocks: [], floors: [], width: 0, height: 0 };
  const maxSloc = Math.max(1, ...files.map((f) => f.sloc));
  const maxVal = Math.max(0, ...files.map((f) => f.value));

  const tiers = makeTiers(files);
  for (const t of tiers) t.files.sort((a, b) => a.path.localeCompare(b.path));
  // Biggest tier at the base. WHY: sizing each slab from its own file count is
  // what keeps blocks filling their floor; if a crowded tier sat above a small
  // one, the lower slab would have to be inflated to stay wider, leaving a
  // large empty rim. Sorting by size makes the taper fall out of the data.
  tiers.sort((a, b) => b.files.length - a.files.length);

  // ---- floor sizes: each from its OWN grid, then nudged to guarantee taper --
  const cols = tiers.map((t) => Math.ceil(Math.sqrt(t.files.length)));
  // Each floor needs room for its own grid; each is also MIN_TAPER narrower
  // per side than the floor below. Solve both at once: pick the smallest base
  // that satisfies every floor, then step inward. This cannot produce a
  // negative size (shrinking blindly upward could), and inflates the base by
  // the least amount possible, so slabs are not left with a wide empty rim.
  // The base is exactly as big as the bottom tier's own grid needs — nothing
  // more. Floors above shrink by a fixed RATIO, which is what makes the
  // silhouette a pyramid at any size. Their grids then squeeze to fit (see
  // `fit` below), so upper floors hold smaller blocks rather than forcing the
  // base to inflate. Growing the base instead (tried first in v0.2.0) left a
  // slab three times wider than its contents, and the result read as a tower
  // standing on empty plates.
  const rows0 = tiers.map((t, i) => Math.ceil(t.files.length / cols[i]));
  const baseWidth = Math.max(cols[0], rows0[0]) * CELL + 2 * PAD;
  const sizes = tiers.map((_, i) => Math.max(MIN_SLAB, baseWidth * Math.pow(SHRINK, i)));

  // ---- vertical: pitch scaled to the base so steps are actually visible ----
  let pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, baseWidth * STEP_RATIO));
  // Invariant C: the whole thing stays wider than it is tall.
  pitch = Math.min(pitch, (MAX_HEIGHT_RATIO * baseWidth) / tiers.length);
  // The slab thins out on small pyramids so it never eats the space the blocks
  // need — otherwise a three-file project renders as pancakes on thick plates.
  const slab = Math.min(SLAB_MAX, pitch * 0.26);
  const maxBlockH = Math.max(MIN_H * 2, pitch - slab - CLEARANCE * pitch);

  const blocks: BlockPlacement[] = [];
  const floors: FloorPlacement[] = [];
  let y = 0;
  tiers.forEach((tier, fi) => {
    const c = cols[fi];
    const rows = Math.ceil(tier.files.length / c);
    // Spread the grid across the whole slab. WHY: the taper rule can make a
    // slab much wider than its own grid needs; at a fixed pitch the files then
    // huddle in the middle of an empty plate and the pyramid reads as a tower
    // with a skirt. Filling the slab is also the honest picture — the floor is
    // as big as it is because of what sits above it. Capped so a floor with
    // three files does not get three enormous slabs.
    const fit = Math.max(0.3, Math.min(MAX_CELL, (sizes[fi] - 2 * PAD) / Math.max(c, rows)));
    floors.push({ depth: tier.depth, label: tier.label, y, size: sizes[fi], thickness: slab, files: tier.files.length });
    const top = y + slab;
    tier.files.forEach((f, i) => {
      const row = Math.floor(i / c);
      // Snake order: neighbouring files in a folder stay adjacent row to row.
      const col = row % 2 === 0 ? i % c : c - 1 - (i % c);
      const w = (MIN_W + (MAX_W - MIN_W) * Math.sqrt(f.sloc / maxSloc)) * fit;
      const h = Math.min(MIN_H + (maxBlockH - MIN_H) * heightFraction(f.value, maxVal), w * MAX_BLOCK_ASPECT);
      blocks.push({
        key: f.key, floor: fi, w, h,
        x: (col - (c - 1) / 2) * CELL * fit,
        z: (row - (rows - 1) / 2) * CELL * fit,
        y: top,
      });
    });
    y += pitch;
  });

  return { blocks, floors, width: baseWidth, height: y };
}
