/* =============================================================================
 * KASAUTI — webview/schema.ts   (v2.1 Code Map — the NeuralSchema-style view)
 * -----------------------------------------------------------------------------
 * WHAT:  A force-directed map of the project on a dark canvas:
 *          project → folders → files (→ functions), plus import edges between
 *          files. Colour = grade (A green … E red), size = lines of code (+ how
 *          many files import it), rings = 360° findings (orange performance,
 *          red security, yellow AI-risk). A crawler animation reveals the map
 *          node by node (BFS / DFS), exactly like NeuralSchema's Crawl Mode.
 * WHY:   Replaces the pyramid as the default view (Kanak: "pyramid sahi nahi
 *          lag raha"). It shows dependencies the pyramid could not, and works
 *          without WebGL (plain 2D canvas), so it also runs in remote/VM setups.
 *        Performance: canvas (not SVG/DOM) + a spatial grid for repulsion, so
 *          a few thousand nodes stay smooth; the simulation cools down and the
 *          loop sleeps when nothing moves.
 * FLOW:  main.ts -> SchemaView.setData(files, changed) -> buildGraph() ->
 *        simulate + draw each animation frame; clicks call back into main.ts
 *        (select file / open function / tooltip).
 * ========================================================================== */

import type { UiFile } from '../src/snapshot';
import { buildGraph, crawlOrder, GNode, Graph } from './schemaGraph';
import { GOLD, gradeColor, h, prefersReducedMotion } from './common';
import LOGO from '../media/logo-mark.svg';

/** What the view needs from the panel around it. */
export interface SchemaHost {
  select(key: string): void;
  open(key: string, line?: number): void;
  selected(): string | undefined;
  tip(key: string | undefined, x: number, y: number, text?: string): void;
}

interface Body { x: number; y: number; vx: number; vy: number; pinned?: boolean }

const BG = '#05070d';
const COL = { root: '#4f8cff', dir: '#8b93a7', tree: 'rgba(160,170,200,0.22)', import: 'rgba(124,140,255,0.22)', perf: '#ff9f43', sec: '#ff4d5e', ai: '#f4d03f' };
const SPRING: Record<string, number> = { 'root-dir': 70, 'root-file': 60, 'dir-dir': 55, 'dir-file': 42, 'file-fn': 16, import: 110 };
const CHARGE: Record<string, number> = { root: 520, dir: 340, file: 190, fn: 30 };

export class SchemaView {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  /** null when the environment has no 2D canvas (tests under jsdom): the map then shows its panel only. */
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly panel: HTMLDivElement;
  private graph: Graph = { nodes: new Map(), edges: [], adj: new Map() };
  private readonly bodies = new Map<string, Body>();
  private cam = { x: 0, y: 0, k: 1 };
  private camTarget: { x: number; y: number; k?: number } | undefined;
  private alpha = 1;
  private files: UiFile[] = [];
  private readonly expanded = new Set<string>();
  private readonly pulses = new Map<string, number>();     // node id -> start time (live-edit flash)
  private hover: string | undefined;
  private drag: { id?: string; sx: number; sy: number; cx: number; cy: number; moved: boolean } | undefined;
  private framed = false;
  /** true once the user pans/zooms: from then on we never move their camera on our own. */
  private userCam = false;
  private settledFramed = false;
  private running = false;
  private font = 'monospace';

  // ---- crawl state --------------------------------------------------------
  private order: Array<{ id: string; via?: string; depth: number }> = [];
  private revealed = 0;               // float: how many of `order` are visible
  private playing = true;
  private readonly opts = { mode: 'bfs' as 'bfs' | 'dfs', speed: 1, crawlers: 3, follow: false, tags: true, functions: false };
  private readonly log: string[] = [];
  private lastTick = performance.now();

  // ---- controls -------------------------------------------------------------
  private readonly playBtn: HTMLButtonElement;
  private readonly scrub: HTMLInputElement;
  private readonly scrubLabel: HTMLSpanElement;

  constructor(private readonly host: SchemaHost) {
    this.canvas = h('canvas', { class: 'schema-canvas', tabindex: 0, 'aria-label': 'Code map: folders, files and imports. Click a file for details; double-click to show its functions.' });
    this.ctx = this.canvas.getContext('2d');
    this.panel = h('div', { class: 'schema-panel', 'aria-live': 'polite' });
    // --- bottom control bar (mirrors NeuralSchema's Crawl Mode controls)
    this.playBtn = h('button', { type: 'button', class: 'sbtn' }, '❚❚ Pause');
    this.playBtn.addEventListener('click', () => { if (this.revealed >= this.order.length) this.restart(); else this.playing = !this.playing; this.syncControls(); this.wake(); });
    const restart = h('button', { type: 'button', class: 'sbtn' }, '↺ Restart');
    restart.addEventListener('click', () => this.restart());
    const order = h('select', { class: 'ssel', 'aria-label': 'Crawl order' }, h('option', { value: 'bfs' }, 'Breadth-first (BFS)'), h('option', { value: 'dfs' }, 'Depth-first (DFS)')) as HTMLSelectElement;
    order.addEventListener('change', () => { this.opts.mode = order.value as 'bfs' | 'dfs'; this.restart(); });
    const speed = h('input', { type: 'range', min: 0.25, max: 4, step: 0.25, value: 1, 'aria-label': 'Speed' }) as HTMLInputElement;
    speed.addEventListener('input', () => { this.opts.speed = Number(speed.value); });
    const crawlers = h('input', { type: 'range', min: 1, max: 8, step: 1, value: 3, 'aria-label': 'Crawlers' }) as HTMLInputElement;
    crawlers.addEventListener('input', () => { this.opts.crawlers = Number(crawlers.value); });
    const toggle = (label: string, key: 'follow' | 'tags' | 'functions') => {
      const b = h('button', { type: 'button', class: 'sbtn toggle', 'aria-pressed': String(this.opts[key]) }, label);
      b.addEventListener('click', () => {
        this.opts[key] = !this.opts[key];
        b.setAttribute('aria-pressed', String(this.opts[key]));
        if (key === 'functions') { if (!this.userCam) this.settledFramed = false; this.rebuild(new Set()); }
        this.wake();
      });
      return b;
    };
    this.scrub = h('input', { type: 'range', class: 'scrub', min: 0, max: 1, step: 1, value: 0, 'aria-label': 'Crawl progress' }) as HTMLInputElement;
    this.scrub.addEventListener('input', () => { this.revealed = Number(this.scrub.value); this.playing = false; this.syncControls(); this.wake(); });
    this.scrubLabel = h('span', { class: 'scrub-n' });
    const bar = h('div', { class: 'schema-bar' },
      h('div', { class: 'row' }, this.playBtn, restart, h('label', {}, 'Order', order), h('label', {}, 'Speed', speed), h('label', {}, 'Crawlers', crawlers),
        toggle('◎ Follow', 'follow'), toggle('▭ Tags', 'tags'), toggle('ƒ Functions', 'functions')),
      h('div', { class: 'row' }, this.scrub, this.scrubLabel));
    const mark = h('div', { class: 'schema-mark' });
    mark.innerHTML = LOGO.replace(/<title>.*?<\/title>/, '');            // our own bundled SVG, not user data
    mark.append(h('span', {}, 'KASAUTI'));
    const title = h('div', { class: 'schema-title' }, h('b', {}, 'Code Map'), h('small', {}, 'folders → files → functions · import links · 360° findings'));
    this.el = h('div', { class: 'schema' }, this.canvas, title, this.panel, bar, mark);

    this.font = getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
    this.bindInput();
    new ResizeObserver(() => { this.resize(); this.wake(); }).observe(this.el);
    if (prefersReducedMotion()) { this.playing = false; }
  }

  /* ========================================================================
   * Data
   * ====================================================================== */
  setData(files: UiFile[], changed: Set<string>): void {
    this.files = files;
    this.rebuild(changed);
  }

  private rebuild(changed: Set<string>): void {
    const prevTotal = this.order.length;
    const wasDone = this.revealed >= prevTotal && prevTotal > 0;
    this.graph = buildGraph(this.files, { functions: this.opts.functions, expanded: this.expanded, maxNodes: 4000 });
    // Keep positions of nodes that survive; place new ones next to their parent.
    for (const id of [...this.bodies.keys()]) if (!this.graph.nodes.has(id)) this.bodies.delete(id);
    for (const n of this.graph.nodes.values()) {
      if (this.bodies.has(n.id)) continue;
      const p = n.parent ? this.bodies.get(n.parent) : undefined;
      const a = Math.random() * Math.PI * 2, d = 20 + Math.random() * 30;
      this.bodies.set(n.id, { x: (p?.x ?? 0) + Math.cos(a) * d, y: (p?.y ?? 0) + Math.sin(a) * d, vx: 0, vy: 0, pinned: n.id === 'root' });
    }
    this.order = crawlOrder(this.graph, this.opts.mode);
    // A finished crawl stays finished: live edits / new files simply appear.
    if (wasDone || prefersReducedMotion()) this.revealed = this.order.length;
    for (const k of changed) this.pulses.set('file:' + k, performance.now());
    this.alpha = Math.max(this.alpha, changed.size || this.order.length !== prevTotal ? 0.6 : 0.15);
    this.scrub.max = String(this.order.length);
    this.syncControls();
    this.wake();
  }

  private restart(): void {
    this.settledFramed = false;
    this.order = crawlOrder(this.graph, this.opts.mode);
    this.revealed = 1;
    this.log.length = 0;
    this.playing = !prefersReducedMotion();
    if (!this.playing) this.revealed = this.order.length;
    this.syncControls();
    this.wake();
  }

  private syncControls(): void {
    const done = this.revealed >= this.order.length;
    this.playBtn.textContent = done ? '▶ Replay' : this.playing ? '❚❚ Pause' : '▶ Play';
    this.scrub.value = String(Math.floor(this.revealed));
    this.scrubLabel.textContent = `${Math.min(this.order.length, Math.floor(this.revealed))} / ${this.order.length}`;
  }

  selectionChanged(): void { this.wake(); }

  focusKey(key: string): void {
    const b = this.bodies.get('file:' + key);
    if (b) { this.camTarget = { x: b.x, y: b.y, k: Math.max(this.cam.k, 1.6) }; this.wake(); }
  }

  /** Fit everything visible into the canvas. */
  frame(): void {
    this.userCam = false;
    const vis = [...this.bodies.entries()].filter(([id]) => this.isVisible(id)).map(([, b]) => b);
    if (!vis.length) return;
    const xs = vis.map((b) => b.x), ys = vis.map((b) => b.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const w = this.canvas.clientWidth || 800, hgt = this.canvas.clientHeight || 600;
    // Leave room for the stats panel (right), title (top) and control bar (bottom).
    const k = Math.min(2.2, Math.max(0.12, Math.min((w - 300) / (x1 - x0 + 120), (hgt - 230) / (y1 - y0 + 120))));
    this.camTarget = { x: (x0 + x1) / 2 + 130 / k, y: (y0 + y1) / 2 + 20 / k, k };
    this.wake();
  }

  /* ========================================================================
   * Loop: simulate while hot, animate while crawling, sleep otherwise
   * ====================================================================== */
  private wake(): void {
    if (this.running) return;
    this.running = true;
    this.lastTick = performance.now();
    requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (!this.el.isConnected) { this.running = false; return; }
    if (this.alpha > 0.015) { this.simulate(); this.simulate(); this.alpha *= 0.985; }
    this.advanceCrawl(dt);
    if (!this.framed && this.order.length && this.alpha < 0.5) { this.framed = true; this.frame(); }
    // The map keeps spreading while it cools; frame again once it has settled
    // (and after the crawl ends), unless the user has taken the camera.
    if (!this.userCam && !this.settledFramed && this.alpha < 0.06 && this.revealed >= this.order.length) { this.settledFramed = true; this.frame(); }
    if (this.camTarget) {
      const t = this.camTarget, e = prefersReducedMotion() ? 1 : 0.12;
      this.cam.x += (t.x - this.cam.x) * e; this.cam.y += (t.y - this.cam.y) * e;
      if (t.k) this.cam.k += (t.k - this.cam.k) * e;
      if (Math.abs(t.x - this.cam.x) < 0.5 && Math.abs(t.y - this.cam.y) < 0.5 && (!t.k || Math.abs(t.k - this.cam.k) < 0.005)) this.camTarget = undefined;
    }
    for (const [id, t0] of this.pulses) if (now - t0 > 1200) this.pulses.delete(id);
    this.draw(now);
    const busy = this.alpha > 0.015 || (this.playing && this.revealed < this.order.length) || this.camTarget || this.pulses.size || this.drag;
    if (busy) requestAnimationFrame(() => this.tick()); else this.running = false;
  }

  private advanceCrawl(dt: number): void {
    if (!this.playing || this.revealed >= this.order.length) return;
    const before = Math.floor(this.revealed);
    // Speed scales with project size so a 2,000-file repo still finishes in ~20 s.
    const rate = Math.max(6, this.order.length / 20) * this.opts.speed * (this.opts.crawlers / 3);
    this.revealed = Math.min(this.order.length, this.revealed + rate * dt);
    for (let i = before; i < Math.floor(this.revealed); i++) {
      const o = this.order[i], n = this.graph.nodes.get(o.id);
      if (!n || !o.via) continue;
      const imp = this.graph.edges.some((e) => e.kind === 'import' && ((e.a === o.via && e.b === o.id) || (e.b === o.via && e.a === o.id)));
      this.log.push(`${imp ? 'imports' : n.kind === 'fn' ? 'defines' : 'contains'} → ${n.label}`);
      if (n.kp?.[1]) this.log.push(`⚠ security finding in ${n.label}`);
      if (this.log.length > 7) this.log.splice(0, this.log.length - 7);
      if (this.opts.follow) { const b = this.bodies.get(o.id); if (b) this.camTarget = { x: b.x, y: b.y }; }
    }
    if (this.revealed >= this.order.length) this.playing = false;
    this.syncControls();
  }

  private isVisible(id: string): boolean {
    if (this.revealed >= this.order.length) return true;
    const i = this.orderIndex().get(id);
    return i !== undefined && i < this.revealed;
  }
  private idxCache: { order: unknown; map: Map<string, number> } | undefined;
  private orderIndex(): Map<string, number> {
    if (this.idxCache?.order !== this.order) this.idxCache = { order: this.order, map: new Map(this.order.map((o, i) => [o.id, i])) };
    return this.idxCache.map;
  }

  /** One physics step: springs on edges, short-range repulsion via a grid,
   *  weak pull to the centre. O(n) per step instead of O(n²). */
  private simulate(): void {
    const a = this.alpha;
    const nodes = this.graph.nodes;
    for (const e of this.graph.edges) {
      const p = this.bodies.get(e.a), q = this.bodies.get(e.b);
      if (!p || !q) continue;
      const na = nodes.get(e.a)!, nb = nodes.get(e.b)!;
      const len = e.kind === 'import' ? SPRING.import : SPRING[`${na.kind}-${nb.kind}`] ?? 50;
      const str = e.kind === 'import' ? 0.004 : 0.11;
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 0.01;
      const f = ((d - len) / d) * str * a;
      if (!q.pinned) { q.vx -= dx * f; q.vy -= dy * f; }
      if (!p.pinned) { p.vx += dx * f; p.vy += dy * f; }
    }
    const CELL = 90;
    const grid = new Map<string, string[]>();
    for (const [id, b] of this.bodies) { const k = `${Math.floor(b.x / CELL)},${Math.floor(b.y / CELL)}`; let c = grid.get(k); if (!c) grid.set(k, (c = [])); c.push(id); }
    for (const [id, b] of this.bodies) {
      if (b.pinned) continue;
      const cx = Math.floor(b.x / CELL), cy = Math.floor(b.y / CELL);
      const qa = CHARGE[nodes.get(id)?.kind ?? 'fn'];
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const other of grid.get(`${gx},${gy}`) ?? []) {
          if (other === id) continue;
          const o = this.bodies.get(other)!;
          let dx = b.x - o.x, dy = b.y - o.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
          if (d2 > CELL * CELL * 2.2) continue;
          const f = ((qa + CHARGE[nodes.get(other)?.kind ?? 'fn']) / 2) * a / d2;
          b.vx += dx * f; b.vy += dy * f;
        }
      }
      b.vx -= b.x * 0.0015 * a; b.vy -= b.y * 0.0015 * a;
    }
    for (const b of this.bodies.values()) {
      if (b.pinned) { b.vx = b.vy = 0; continue; }
      b.vx *= 0.6; b.vy *= 0.6;
      b.x += Math.max(-30, Math.min(30, b.vx)); b.y += Math.max(-30, Math.min(30, b.vy));
    }
  }

  /* ========================================================================
   * Drawing
   * ====================================================================== */
  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
  }

  private toScreen(b: { x: number; y: number }): [number, number] {
    return [(b.x - this.cam.x) * this.cam.k + this.canvas.clientWidth / 2, (b.y - this.cam.y) * this.cam.k + this.canvas.clientHeight / 2];
  }
  private toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.canvas.clientWidth / 2) / this.cam.k + this.cam.x, (sy - this.canvas.clientHeight / 2) / this.cam.k + this.cam.y];
  }

  private nodeColor(n: GNode): string {
    if (n.kind === 'root') return COL.root;
    if (n.kind === 'dir') return COL.dir;
    return n.grade ? gradeColor(n.grade) : COL.dir;
  }

  private draw(now: number): void {
    const g = this.ctx;
    if (!g) { this.renderPanel(); return; }
    const dpr = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    const k = this.cam.k;
    const sel = this.host.selected();
    const focus = this.hover ?? (sel ? 'file:' + sel : undefined);
    const near = new Set<string>(focus ? [focus, ...(this.graph.adj.get(focus) ?? [])] : []);
    const vis = (id: string) => this.isVisible(id);

    // ---- edges
    for (const e of this.graph.edges) {
      if (!vis(e.a) || !vis(e.b)) continue;
      const p = this.bodies.get(e.a)!, q = this.bodies.get(e.b)!;
      const [x1, y1] = this.toScreen(p), [x2, y2] = this.toScreen(q);
      const hot = focus && (e.a === focus || e.b === focus);
      g.strokeStyle = hot ? (e.kind === 'import' ? '#a9b6ff' : 'rgba(220,225,240,0.7)') : e.kind === 'import' ? COL.import : COL.tree;
      g.lineWidth = hot ? 1.8 : e.kind === 'import' ? 1 : 0.9;
      g.beginPath(); g.moveTo(x1, y1);
      if (e.kind === 'import') {
        // Curved, so imports read as "links across the tree", not as more tree.
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
        g.quadraticCurveTo(mx - dy * 0.18, my + dx * 0.18, x2, y2);
      } else g.lineTo(x2, y2);
      g.stroke();
    }

    // ---- crawler trails: the most recently discovered edges glow white
    if (this.revealed < this.order.length) {
      const head = Math.floor(this.revealed);
      for (let i = Math.max(1, head - this.opts.crawlers * 2); i < head; i++) {
        const o = this.order[i];
        if (!o.via) continue;
        const p = this.bodies.get(o.via), q = this.bodies.get(o.id);
        if (!p || !q) continue;
        const [x1, y1] = this.toScreen(p), [x2, y2] = this.toScreen(q);
        const f = this.revealed - i;                                    // 0..crawlers*2: how far along
        const t = Math.min(1, f / 1.5);
        g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1.8;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t); g.stroke();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 3, 0, Math.PI * 2); g.fill();
      }
    }

    // ---- nodes (functions first so files/folders sit on top)
    const drawn: Array<[GNode, number, number, number]> = [];
    for (const kind of ['fn', 'file', 'dir', 'root'] as const) {
      for (const n of this.graph.nodes.values()) {
        if (n.kind !== kind || !vis(n.id)) continue;
        const b = this.bodies.get(n.id)!;
        const [x, y] = this.toScreen(b);
        const r = Math.max(1.5, n.r * Math.sqrt(k));
        if (x < -40 || y < -40 || x > this.canvas.clientWidth + 40 || y > this.canvas.clientHeight + 40) continue;
        const dim = focus && !near.has(n.id) ? 0.35 : 1;
        g.globalAlpha = dim;
        g.fillStyle = this.nodeColor(n);
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        if (n.partial) { g.strokeStyle = 'rgba(255,255,255,0.5)'; g.setLineDash([2, 2]); g.lineWidth = 1; g.stroke(); g.setLineDash([]); }
        // 360° rings: performance / security / AI-risk, one third each.
        if (n.kp) [COL.perf, COL.sec, COL.ai].forEach((c, i) => {
          if (!n.kp![i]) return;
          g.strokeStyle = c; g.lineWidth = 2;
          g.beginPath(); g.arc(x, y, r + 3, -Math.PI / 2 + (i * 2 * Math.PI) / 3 + 0.12, -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / 3 - 0.12); g.stroke();
        });
        if (n.key && n.kind === 'file' && n.key === sel) { g.strokeStyle = GOLD; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, r + 6, 0, Math.PI * 2); g.stroke(); }
        const t0 = this.pulses.get(n.id);
        if (t0 !== undefined) {
          const p = (now - t0) / 1200;
          g.strokeStyle = GOLD; g.globalAlpha = (1 - p) * dim; g.lineWidth = 2;
          g.beginPath(); g.arc(x, y, r + 4 + p * 26, 0, Math.PI * 2); g.stroke();
        }
        g.globalAlpha = 1;
        drawn.push([n, x, y, r]);
      }
    }

    // ---- tags (labels in boxes, like NeuralSchema)
    g.font = `${11}px ${this.font}`;
    g.textBaseline = 'middle';
    const few = this.files.length < 60;
    const prio = (n: GNode) => (n.id === focus ? 0 : near.has(n.id) ? 1 : n.kind === 'root' ? 2 : n.kind === 'dir' ? 3 : n.kind === 'file' ? 4 - Math.min(0.9, n.r / 20) : 6);
    const placed: Array<[number, number, number, number]> = [];
    const overlaps = (a: [number, number, number, number]) => placed.some((b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]);
    for (const [n, x, y, r] of [...drawn].sort((a, b) => prio(a[0]) - prio(b[0]))) {
      const forced = n.id === focus || near.has(n.id);
      const show = forced || (this.opts.tags && (n.kind === 'root' || n.kind === 'dir' || (n.kind === 'file' && (few || k > 0.55)) || (n.kind === 'fn' && k > 1.8)));
      if (!show) continue;
      const text = n.label.length > 36 ? n.label.slice(0, 35) + '…' : n.label;
      const w = g.measureText(text).width + 10, hh = 16;
      const lx = x + r + 5, ly = y - hh / 2;
      // Skip a label that would sit on top of a more important one (zoom in to see it).
      const box: [number, number, number, number] = [lx - 2, ly - 1, w + 4, hh + 2];
      if (!forced && overlaps(box)) continue;
      placed.push(box);
      g.globalAlpha = focus && !near.has(n.id) ? 0.35 : n.id === focus ? 1 : 0.85;
      g.fillStyle = n.id === focus ? 'rgba(210,220,240,0.95)' : 'rgba(10,13,22,0.82)';
      g.strokeStyle = n.kind === 'file' || n.kind === 'fn' ? this.nodeColor(n) : 'rgba(150,160,190,0.6)';
      g.lineWidth = 1;
      g.beginPath(); g.roundRect?.(lx, ly, w, hh, 3); if (!g.roundRect) g.rect(lx, ly, w, hh); g.fill(); g.stroke();
      g.fillStyle = n.id === focus ? '#0b0e16' : n.kind === 'fn' ? '#c8cede' : '#e6e9f2';
      g.fillText(text, lx + 5, y);
      g.globalAlpha = 1;
    }
    this.renderPanel();
  }

  /** Top-right stats + log + legend (DOM, so it is selectable and accessible). */
  private panelSig = '';
  private renderPanel(): void {
    const total = this.order.length, done = Math.min(total, Math.floor(this.revealed));
    const idx = this.orderIndex();
    let frontier = 0;
    if (done < total) for (let i = done; i < total; i++) { const v = this.order[i].via; if (v !== undefined && (idx.get(v) ?? Infinity) < done) frontier++; }
    const depth = done ? this.order[done - 1].depth : 0;
    let sec = 0, perf = 0, ai = 0, imports = 0;
    for (const n of this.graph.nodes.values()) if (n.kp && this.isVisible(n.id)) { perf += n.kp[0]; sec += n.kp[1]; ai += n.kp[2]; }
    for (const e of this.graph.edges) if (e.kind === 'import') imports++;
    const sig = [done, total, frontier, depth, sec, perf, ai, imports, this.log.join('|')].join(';');
    if (sig === this.panelSig) return;
    this.panelSig = sig;
    const row = (a: string, b: string | number) => h('div', { class: 'srow' }, h('span', {}, a), h('b', {}, String(b)));
    const pct = total ? (100 * done) / total : 0;
    this.panel.replaceChildren(
      row('discovered', `${done} / ${total}`),
      h('div', { class: 'sprog' }, h('i', { style: `width:${pct}%` })),
      row('frontier (queued)', frontier), row('depth', depth), row('links followed', Math.max(0, done - 1)), row('import links', imports),
      h('div', { class: 'slog' }, ...this.log.slice(-6).map((l) => h('div', { class: l.startsWith('⚠') ? 'warn' : '' }, l))),
      h('div', { class: 'slegend' },
        h('span', {}, h('i', { style: `background:${COL.root}` }), 'project'), h('span', {}, h('i', { style: `background:${COL.dir}` }), 'folder'),
        h('span', {}, h('i', { style: `background:${gradeColor('A')}` }), 'file A…E'), h('span', {}, h('i', { class: 'ln' }), 'import'),
        h('span', {}, h('i', { class: 'ring', style: `border-color:${COL.perf}` }), `performance ${perf}`),
        h('span', {}, h('i', { class: 'ring', style: `border-color:${COL.sec}` }), `security ${sec}`),
        h('span', {}, h('i', { class: 'ring', style: `border-color:${COL.ai}` }), `AI-risk ${ai}`)));
  }

  /* ========================================================================
   * Input: pan, zoom, drag nodes, hover, click, double-click
   * ====================================================================== */
  private pick(sx: number, sy: number): string | undefined {
    const [wx, wy] = this.toWorld(sx, sy);
    let best: string | undefined, bestD = Infinity;
    for (const n of this.graph.nodes.values()) {
      if (!this.isVisible(n.id)) continue;
      const b = this.bodies.get(n.id)!;
      const d = Math.hypot(b.x - wx, b.y - wy);
      const hit = Math.max(n.r * Math.sqrt(this.cam.k), 6) / this.cam.k + 2;
      if (d < hit && d < bestD) { best = n.id; bestD = d; }
    }
    return best;
  }

  private bindInput(): void {
    const c = this.canvas;
    const local = (e: MouseEvent) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      const [wx, wy] = this.toWorld(sx, sy);
      this.cam.k = Math.max(0.08, Math.min(6, this.cam.k * Math.exp(-e.deltaY * 0.0015)));
      // keep the point under the cursor fixed while zooming
      this.cam.x = wx - (sx - c.clientWidth / 2) / this.cam.k;
      this.cam.y = wy - (sy - c.clientHeight / 2) / this.cam.k;
      this.camTarget = undefined;
      this.userCam = true;
      this.wake();
    }, { passive: false });
    c.addEventListener('mousedown', (e) => {
      const [sx, sy] = local(e);
      this.drag = { id: this.pick(sx, sy), sx, sy, cx: this.cam.x, cy: this.cam.y, moved: false };
      this.camTarget = undefined;
    });
    window.addEventListener('mousemove', (e) => {
      const [sx, sy] = local(e);
      if (this.drag) {
        const d = this.drag;
        if (Math.hypot(sx - d.sx, sy - d.sy) > 3) d.moved = true;
        if (!d.moved) return;
        if (d.id && d.id !== 'root') {
          const b = this.bodies.get(d.id)!;
          [b.x, b.y] = this.toWorld(sx, sy);
          b.pinned = true; b.vx = b.vy = 0;
          this.alpha = Math.max(this.alpha, 0.25);
        } else {
          this.userCam = true;
          this.cam.x = d.cx - (sx - d.sx) / this.cam.k;
          this.cam.y = d.cy - (sy - d.sy) / this.cam.k;
        }
        this.wake();
        return;
      }
      if (e.target !== c) return;
      const id = this.pick(sx, sy);
      if (id !== this.hover) { this.hover = id; this.wake(); }
      const n = id ? this.graph.nodes.get(id) : undefined;
      c.style.cursor = n ? 'pointer' : 'grab';
      if (n?.kind === 'file') this.host.tip(n.key, e.clientX, e.clientY);
      else if (n?.kind === 'fn') this.host.tip(undefined, e.clientX, e.clientY, `${n.label} — line ${n.line! + 1}, grade ${n.grade}. Click to open.`);
      else if (n?.kind === 'dir') this.host.tip(undefined, e.clientX, e.clientY, `${n.label} — double-click a file to show its functions`);
      else this.host.tip(undefined, 0, 0);
    });
    window.addEventListener('mouseup', () => {
      const d = this.drag;
      this.drag = undefined;
      if (!d || d.moved) { if (d?.id && d.id !== 'root') { const b = this.bodies.get(d.id); if (b) b.pinned = false; } return; }
      const n = d.id ? this.graph.nodes.get(d.id) : undefined;
      if (n?.kind === 'file' && n.key) this.host.select(n.key);
      else if (n?.kind === 'fn' && n.key) this.host.open(n.key, n.line);
      else if (n?.kind === 'dir' || n?.kind === 'root') { const b = this.bodies.get(n.id)!; this.camTarget = { x: b.x, y: b.y, k: Math.max(this.cam.k, 1.2) }; this.wake(); }
    });
    c.addEventListener('dblclick', (e) => {
      const [sx, sy] = local(e);
      const n = this.graph.nodes.get(this.pick(sx, sy) ?? '');
      if (n?.kind !== 'file' || !n.key) return;
      if (this.expanded.has(n.key)) this.expanded.delete(n.key); else this.expanded.add(n.key);
      this.rebuild(new Set());
    });
    c.addEventListener('mouseleave', () => { this.hover = undefined; this.host.tip(undefined, 0, 0); this.wake(); });
  }
}
