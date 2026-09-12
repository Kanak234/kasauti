/* =============================================================================
 * KASAUTI — webview/layout.ts
 * -----------------------------------------------------------------------------
 * WHAT:  Pure function: list of files -> 3D positions and sizes of every block
 *        and every floor ("slab") of the pyramid.
 * WHY:   Kept free of Three.js/DOM so it can be unit-tested in Node, and so the
 *        exact geometry rules from the UI brief §C5 live in one place:
 *          - one floor per folder depth (root at the bottom)
 *          - upper floors are always smaller -> a stepped pyramid (ziggurat)
 *          - floors float apart ("exploded view") so lower blocks stay visible
 *          - block footprint ~ sqrt(SLOC), block height ~ log(metric)
 *          - files of the same folder sit next to each other
 * FLOW:  main.ts calls layoutPyramid(files, metric) after every update and
 *        writes the result into InstancedMesh matrices.
 * ========================================================================== */

export interface LayoutInput {
  key: string;
  path: string;
  sloc: number;
  value: number;       // the metric mapped to height (debt, complexity, ...)
}

export interface BlockPlacement {
  key: string;
  x: number; z: number;   // center on the floor
  y: number;              // floor top (block base)
  w: number;              // footprint width (square)
  h: number;              // height
  floor: number;
}

export interface FloorPlacement { depth: number; y: number; size: number; thickness: number; files: number }

export interface PyramidLayout { blocks: BlockPlacement[]; floors: FloorPlacement[]; width: number; height: number }

const CELL = 1;             // grid cell size (world units)
const PAD = 1;              // margin between blocks grid and floor edge
const STEP = 1.2;           // each lower floor is at least this much wider per side
const SLAB = 0.18;          // floor thickness
const GAP = 1.1;            // empty space above the tallest block of a floor
export const MAX_H = 3.2;   // tallest possible block
const MIN_H = 0.12;

/** Log-scaled height so one huge file does not flatten everything else. */
export function heightOf(value: number, max: number): number {
  if (max <= 0 || value <= 0) return MIN_H;
  return MIN_H + (MAX_H - MIN_H) * (Math.log1p(value) / Math.log1p(max));
}

export function layoutPyramid(files: LayoutInput[]): PyramidLayout {
  if (!files.length) return { blocks: [], floors: [], width: 0, height: 0 };
  const maxSloc = Math.max(1, ...files.map((f) => f.sloc));
  const maxVal = Math.max(0, ...files.map((f) => f.value));

  // 1) Group by folder depth; inside a floor keep folders contiguous.
  const byDepth = new Map<number, LayoutInput[]>();
  for (const f of files) {
    const d = f.path.split('/').length - 1;
    const list = byDepth.get(d) ?? [];
    list.push(f);
    byDepth.set(d, list);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (const d of depths) byDepth.get(d)!.sort((a, b) => a.path.localeCompare(b.path));

  // 2) Floor sizes, top-down, so every floor is wider than the one above it.
  const cols = new Map<number, number>();
  const size = new Map<number, number>();
  for (const d of depths) cols.set(d, Math.ceil(Math.sqrt(byDepth.get(d)!.length)));
  let above = 0;
  for (let i = depths.length - 1; i >= 0; i--) {
    const d = depths[i];
    const needed = cols.get(d)! * CELL + 2 * PAD;
    const s = Math.max(needed, above > 0 ? above + 2 * STEP : 0);
    size.set(d, s);
    above = s;
  }

  // 3) Place floors bottom-up and blocks on a centered grid (snake order so
  //    neighbouring files of the same folder stay adjacent row to row).
  const blocks: BlockPlacement[] = [];
  const floors: FloorPlacement[] = [];
  let y = 0;
  depths.forEach((d, floorIdx) => {
    const list = byDepth.get(d)!;
    const c = cols.get(d)!;
    const rows = Math.ceil(list.length / c);
    const s = size.get(d)!;
    floors.push({ depth: d, y, size: s, thickness: SLAB, files: list.length });
    const top = y + SLAB / 2;
    let tallest = 0;
    list.forEach((f, i) => {
      const row = Math.floor(i / c);
      const colRaw = i % c;
      const col = row % 2 === 0 ? colRaw : c - 1 - colRaw;
      const x = (col - (c - 1) / 2) * CELL;
      const z = (row - (rows - 1) / 2) * CELL;
      const w = CELL * (0.32 + 0.56 * Math.sqrt(f.sloc / maxSloc));
      const h = heightOf(f.value, maxVal);
      tallest = Math.max(tallest, h);
      blocks.push({ key: f.key, x, z, y: top, w, h, floor: floorIdx });
    });
    y = top + tallest + GAP;
  });
  const width = Math.max(...floors.map((f) => f.size));
  return { blocks, floors, width, height: y };
}
