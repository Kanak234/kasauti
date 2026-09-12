/* =============================================================================
 * KASAUTI — webview/main.ts  (the Pyramid panel)
 * -----------------------------------------------------------------------------
 * WHAT:  The showpiece view with three ways to see the same data:
 *          Pyramid — 3D stepped pyramid: floors = folder depth, blocks = files,
 *                    color = grade, height = chosen metric (Three.js/WebGL)
 *          Treemap — 2D rectangles sized by lines of code (fallback when WebGL
 *                    is missing, and faster to scan by eye)
 *          List    — sortable table; the keyboard / screen-reader path
 *        plus a detail drawer (functions + findings with fix steps) and a
 *        hover tooltip.
 * WHY:   UI brief §C5–C8. Live requirement: when a file is re-analyzed while
 *        the user types, its block eases to the new height and a gold streak
 *        flashes across it — the touchstone mark — so the change is visible
 *        without hunting for it. New blocks rise from the floor during a scan,
 *        so the structure visibly builds itself.
 * FLOW:  host posts 'init' / 'files' / 'detail' / 'focus' -> state -> active
 *        view re-renders; user clicks post 'detail' / 'open' back to the host.
 * ========================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import type { UiDetail, UiFile, UiSummary } from '../src/snapshot';
import type { Grade } from '../src/engine/types';
import { GOLD, esc, fill, formatDebt, gradeColor, gradeInk, h, loadState, onHost, prefersReducedMotion, saveState, send, setColorBlind } from './common';
import { layoutPyramid, PyramidLayout } from './layout';

/* =============================================================================
 * State
 * ========================================================================== */
type View = 'pyramid' | 'treemap' | 'list';
type Metric = 'debt' | 'cc' | 'cog' | 'dup';
const METRICS: Array<[Metric, string]> = [
  ['debt', 'Technical debt'], ['cc', 'Cyclomatic complexity'], ['cog', 'Cognitive complexity'], ['dup', 'Duplicated lines'],
];
const metricValue = (f: UiFile, m: Metric) => (m === 'debt' ? f.debt : m === 'cc' ? f.maxCC : m === 'cog' ? f.maxCog : f.dupLines);

const saved = loadState<{ view: View; metric: Metric }>();
const state = {
  files: new Map<string, UiFile>(),
  summary: undefined as UiSummary | undefined,
  view: (saved?.view ?? 'pyramid') as View,
  metric: (saved?.metric ?? 'debt') as Metric,
  selected: undefined as string | undefined,
  detail: undefined as UiDetail | undefined,
  sort: { col: 'debt', dir: -1 } as { col: keyof UiFile; dir: 1 | -1 },
};
const visibleFiles = () => [...state.files.values()].filter((f) => f.tier !== 3);
const persist = () => saveState({ view: state.view, metric: state.metric });

/* =============================================================================
 * DOM skeleton
 * ========================================================================== */
const app = document.getElementById('app')!;
const toolbar = h('header', { class: 'toolbar' });
const stage = h('main', { class: 'stage', id: 'stage' });
const drawer = h('aside', { class: 'drawer', 'aria-label': 'File details', hidden: true });
const tooltip = h('div', { class: 'tip', role: 'tooltip', hidden: true });
const progress = h('div', { class: 'scanbar', hidden: true }, h('i'));
const legend = h('div', { class: 'legendbar' });
const notice = h('div', { class: 'notice', hidden: true });
app.append(toolbar, h('div', { class: 'body' }, stage, drawer));
stage.append(progress, tooltip, legend, notice);

/* ---- toolbar ---------------------------------------------------------------- */
const viewSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' });
for (const [v, label] of [['pyramid', 'Pyramid'], ['treemap', 'Treemap'], ['list', 'List']] as Array<[View, string]>) {
  const b = h('button', { type: 'button', role: 'radio', 'data-v': v }, label);
  b.addEventListener('click', () => setView(v));
  viewSeg.append(b);
}
const metricSel = h('select', { 'aria-label': 'Block height shows' });
for (const [m, label] of METRICS) metricSel.append(h('option', { value: m }, label));
metricSel.value = state.metric;
metricSel.addEventListener('change', () => { state.metric = metricSel.value as Metric; persist(); renderAll(new Set()); });
const resetBtn = h('button', { type: 'button', class: 'btn' }, 'Reset view');
const worstBtn = h('button', { type: 'button', class: 'btn' }, 'Worst file');
const hallmark = h('div', { class: 'mini-mark', 'aria-live': 'polite' });
const scanBtn = h('button', { type: 'button', class: 'btn' }, 'Rescan');
scanBtn.addEventListener('click', () => send({ type: 'command', id: state.summary?.scanning ? 'cancel' : 'scan' }));
resetBtn.addEventListener('click', () => pyramid?.frame(true));
worstBtn.addEventListener('click', () => {
  const worst = visibleFiles().sort((a, b) => b.debt - a.debt)[0];
  if (worst) select(worst.key, true);
});
toolbar.append(viewSeg,
  h('label', { class: 'metric' }, h('span', {}, 'Height shows'), metricSel),
  resetBtn, worstBtn, h('span', { class: 'spacer' }), hallmark, scanBtn);

function setView(v: View): void {
  state.view = v;
  persist();
  renderAll(new Set());
}

/* =============================================================================
 * 3D PYRAMID (Three.js)
 * ========================================================================== */
interface Anim { from: number; to: number; t0: number; flash?: number }

class Pyramid {
  readonly el: HTMLDivElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
  private readonly controls: OrbitControls;
  private readonly floors = new THREE.Group();
  private meshes: [THREE.InstancedMesh, THREE.InstancedMesh];   // [full, partial]
  private keysByMesh: [string[], string[]] = [[], []];
  private readonly where = new Map<string, { m: 0 | 1; i: number }>();
  private readonly heights = new Map<string, number>();         // current displayed height
  private readonly anims = new Map<string, Anim>();
  private layout: PyramidLayout | undefined;
  private readonly hoverBox: THREE.LineSegments;
  private readonly selectBox: THREE.LineSegments;
  private readonly sun: THREE.DirectionalLight;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private framed = false;
  private hovered: string | undefined;
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpC = new THREE.Color();
  private readonly gold = new THREE.Color(GOLD);

  constructor() {
    this.el = h('div', { class: 'gl', tabindex: 0, 'aria-label': 'Pyramid of files. Arrow keys move between files, Enter shows details, O opens the file.' });
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.el.append(this.renderer.domElement);

    // Light: cool sky + warm key light, like a stone slab by a window.
    this.scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x2a2418, 0.85));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 1.55);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target, this.floors);
    const rim = new THREE.DirectionalLight(0x8fa6ff, 0.35);
    rim.position.set(-30, 18, -40);
    this.scene.add(rim);

    // Two instanced meshes: full analysis (plain) and partial (striped).
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const full = new THREE.MeshStandardMaterial({ roughness: 0.52, metalness: 0.08 });
    const partial = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05, map: stripeTexture() });
    this.meshes = [this.makeMesh(geo, full, 256), this.makeMesh(geo, partial, 64)];

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.hoverBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0.55 }));
    this.selectBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: GOLD }));
    this.hoverBox.visible = this.selectBox.visible = false;
    this.scene.add(this.hoverBox, this.selectBox);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !prefersReducedMotion();
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.47;   // never go under the floor
    this.controls.minDistance = 3;

    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private makeMesh(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, new THREE.Color(0xffffff));      // allocates instanceColor
    m.castShadow = true;
    m.receiveShadow = true;
    m.count = 0;
    this.scene.add(m);
    return m;
  }

  /** Grow an instanced mesh when a workspace has more files than capacity. */
  private ensureCapacity(which: 0 | 1, n: number): void {
    const m = this.meshes[which];
    if (n <= m.instanceMatrix.count) return;
    this.scene.remove(m);
    m.dispose();
    let cap = m.instanceMatrix.count;
    while (cap < n) cap *= 2;
    this.meshes[which] = this.makeMesh(m.geometry, m.material as THREE.Material, cap);
  }

  /** Apply new data. `changed` = keys re-analyzed since the last call. */
  setData(files: UiFile[], metric: Metric, changed: Set<string>): void {
    const now = performance.now();
    const reduce = prefersReducedMotion();
    const layout = layoutPyramid(files.map((f) => ({ key: f.key, path: f.path, sloc: f.sloc, value: metricValue(f, metric) })));
    const floorsChanged = !this.layout || JSON.stringify(this.layout.floors) !== JSON.stringify(layout.floors);
    this.layout = layout;
    if (floorsChanged) this.buildFloors(layout);

    const byKey = new Map(files.map((f) => [f.key, f]));
    const split: [typeof layout.blocks, typeof layout.blocks] = [[], []];
    for (const b of layout.blocks) split[byKey.get(b.key)!.tier === 2 ? 1 : 0].push(b);
    this.ensureCapacity(0, split[0].length);
    this.ensureCapacity(1, split[1].length);
    this.where.clear();
    this.keysByMesh = [[], []];

    ([0, 1] as const).forEach((mi) => {
      const mesh = this.meshes[mi];
      split[mi].forEach((b, i) => {
        const f = byKey.get(b.key)!;
        this.where.set(b.key, { m: mi, i });
        this.keysByMesh[mi].push(b.key);
        const current = this.heights.get(b.key);
        if (current === undefined) {
          // New block: rise from the floor (the structure builds itself).
          this.heights.set(b.key, reduce ? b.h : 0.001);
          if (!reduce) this.anims.set(b.key, { from: 0.001, to: b.h, t0: now + Math.random() * 120 });
        } else if (Math.abs(current - b.h) > 1e-3) {
          this.anims.set(b.key, { from: current, to: b.h, t0: now, flash: changed.has(b.key) && !reduce ? now : undefined });
        } else if (changed.has(b.key) && !reduce) {
          this.anims.set(b.key, { from: current, to: current, t0: now, flash: now });
        }
        this.writeInstance(mi, i, b, this.heights.get(b.key)!);
        mesh.setColorAt(i, this.tmpC.set(gradeColor(f.grade)));
      });
      mesh.count = split[mi].length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
    for (const k of [...this.heights.keys()]) if (!byKey.has(k)) { this.heights.delete(k); this.anims.delete(k); }
    if (!this.framed && files.length) this.frame(false);
    this.placeBox(this.selectBox, state.selected);
    this.placeBox(this.hoverBox, this.hovered);
  }

  private block(key: string) { return this.layout?.blocks.find((b) => b.key === key); }

  private writeInstance(mi: 0 | 1, i: number, b: { x: number; y: number; z: number; w: number }, height: number): void {
    this.tmpM.makeScale(b.w, height, b.w).setPosition(b.x, b.y + height / 2, b.z);
    this.meshes[mi].setMatrixAt(i, this.tmpM);
  }

  /** Stone slabs, one per folder depth, with a faint gold edge. */
  private buildFloors(layout: PyramidLayout): void {
    for (const c of [...this.floors.children]) {
      this.floors.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x2c323d, roughness: 0.92, metalness: 0.02 });
    const edgeMat = new THREE.LineBasicMaterial({ color: GOLD, transparent: true, opacity: 0.28 });
    for (const f of layout.floors) {
      const geo = new THREE.BoxGeometry(f.size, f.thickness, f.size);
      const slab = new THREE.Mesh(geo, slabMat);
      slab.position.set(0, f.y, 0);
      slab.receiveShadow = true;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      edge.position.copy(slab.position);
      this.floors.add(slab, edge);
    }
    // Shadow camera must cover the whole pyramid.
    const s = layout.width * 0.75 + 4;
    const cam = this.sun.shadow.camera;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s; cam.near = 1; cam.far = layout.width * 4 + 80;
    cam.updateProjectionMatrix();
    this.sun.position.set(layout.width * 0.8 + 10, layout.height + layout.width + 12, layout.width * 0.55 + 8);
    this.sun.target.position.set(0, layout.height * 0.3, 0);
  }

  /** Point the camera at the whole pyramid. */
  frame(animate: boolean): void {
    if (!this.layout) return;
    this.framed = true;
    const { width, height } = this.layout;
    const target = new THREE.Vector3(0, height * 0.38, 0);
    const dist = Math.max(width, height) * 1.55 + 6;
    const pos = new THREE.Vector3(dist * 0.72, height * 0.5 + dist * 0.62, dist * 0.72);
    this.flyTo(pos, target, animate);
  }

  focusKey(key: string): void {
    const b = this.block(key);
    if (!b) return;
    const target = new THREE.Vector3(b.x, b.y + b.h / 2, b.z);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.flyTo(target.clone().add(dir.multiplyScalar(Math.max(8, (this.layout?.width ?? 10) * 0.45))), target, true);
  }

  private fly: { p0: THREE.Vector3; p1: THREE.Vector3; t0v: THREE.Vector3; t1v: THREE.Vector3; t0: number } | undefined;
  private flyTo(pos: THREE.Vector3, target: THREE.Vector3, animate: boolean): void {
    if (!animate || prefersReducedMotion()) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      return;
    }
    this.fly = { p0: this.camera.position.clone(), p1: pos, t0v: this.controls.target.clone(), t1v: target, t0: performance.now() };
  }

  /** Per-frame: camera flight, block height easing, gold streak flashes. */
  private tick(): void {
    const now = performance.now();
    if (this.fly) {
      const t = Math.min(1, (now - this.fly.t0) / 650);
      const e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.fly.p0, this.fly.p1, e);
      this.controls.target.lerpVectors(this.fly.t0v, this.fly.t1v, e);
      if (t >= 1) this.fly = undefined;
    }
    if (this.anims.size) {
      const dirty = new Set<0 | 1>();
      for (const [key, a] of this.anims) {
        const w = this.where.get(key);
        const b = w && this.block(key);
        if (!w || !b) { this.anims.delete(key); continue; }
        const t = Math.max(0, Math.min(1, (now - a.t0) / 480));
        const e = 1 - Math.pow(1 - t, 3);
        const hgt = a.from + (a.to - a.from) * e;
        this.heights.set(key, hgt);
        this.writeInstance(w.m, w.i, b, hgt);
        dirty.add(w.m);
        // Gold streak: blend toward gold, then back to the grade color.
        const f = state.files.get(key);
        if (a.flash !== undefined && f) {
          const ft = Math.min(1, (now - a.flash) / 900);
          const glow = Math.sin(Math.PI * ft);
          this.meshes[w.m].setColorAt(w.i, this.tmpC.set(gradeColor(f.grade)).lerp(this.gold, glow * 0.85));
          if (ft >= 1) a.flash = undefined;
        }
        if (t >= 1 && a.flash === undefined) this.anims.delete(key);
      }
      for (const m of dirty) {
        this.meshes[m].instanceMatrix.needsUpdate = true;
        if (this.meshes[m].instanceColor) this.meshes[m].instanceColor!.needsUpdate = true;
        this.meshes[m].computeBoundingSphere();
      }
      this.placeBox(this.selectBox, state.selected);
      this.placeBox(this.hoverBox, this.hovered);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private placeBox(box: THREE.LineSegments, key: string | undefined): void {
    const b = key ? this.block(key) : undefined;
    if (!b || !key) { box.visible = false; return; }
    const hgt = this.heights.get(key) ?? b.h;
    box.visible = true;
    box.scale.set(b.w * 1.06, hgt * 1.03 + 0.02, b.w * 1.06);
    box.position.set(b.x, b.y + hgt / 2, b.z);
  }

  private resize(): void {
    const w = this.el.clientWidth, hh = this.el.clientHeight;
    if (!w || !hh) return;
    this.renderer.setSize(w, hh, false);
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
  }

  /** Which file is under the pointer? */
  private pick(ev: PointerEvent | MouseEvent): string | undefined {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes, false);
    const hit = hits.find((x) => x.instanceId !== undefined);
    if (!hit) return undefined;
    const mi = this.meshes.indexOf(hit.object as THREE.InstancedMesh) as 0 | 1;
    return this.keysByMesh[mi][hit.instanceId!];
  }

  private bindInput(): void {
    const c = this.renderer.domElement;
    let down: { x: number; y: number } | undefined;
    c.addEventListener('pointermove', (ev) => {
      const key = this.pick(ev);
      if (key !== this.hovered) { this.hovered = key; this.placeBox(this.hoverBox, key); }
      c.style.cursor = key ? 'pointer' : 'grab';
      showTip(key, ev.clientX, ev.clientY);
    });
    c.addEventListener('pointerleave', () => { this.hovered = undefined; this.placeBox(this.hoverBox, undefined); showTip(undefined, 0, 0); });
    c.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
    c.addEventListener('pointerup', (ev) => {
      // A click, not the end of an orbit drag.
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
      const key = this.pick(ev);
      if (key) select(key, false);
    });
    c.addEventListener('dblclick', (ev) => { const key = this.pick(ev); if (key) send({ type: 'open', key }); });
    this.el.addEventListener('keydown', (ev) => keyNav(ev));
  }

  selectionChanged(): void { this.placeBox(this.selectBox, state.selected); }
}

/** Diagonal stripes = "partial analysis" (no parser for this language). */
function stripeTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#9c9c9c'; g.lineWidth = 7;
  for (let i = -64; i < 128; i += 18) { g.beginPath(); g.moveTo(i, 64); g.lineTo(i + 64, 0); g.stroke(); }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let pyramid: Pyramid | undefined;
let webglError: string | undefined;
function getPyramid(): Pyramid | undefined {
  if (pyramid || webglError) return pyramid;
  try { pyramid = new Pyramid(); }
  catch (e) { webglError = String((e as Error)?.message ?? e); }
  return pyramid;
}

/* =============================================================================
 * TREEMAP (2D SVG)
 * ========================================================================== */
const treeEl = h('div', { class: 'treemap' });
function renderTreemap(): void {
  const files = visibleFiles().filter((f) => f.sloc > 0);
  const W = stage.clientWidth || 800, H = Math.max(200, stage.clientHeight - 36);
  interface N { name: string; children?: N[]; file?: UiFile }
  const root: N = { name: '', children: [] };
  for (const f of files) {
    let node = root;
    for (const p of f.path.split('/').slice(0, -1)) {
      let c = node.children!.find((x) => x.name === p && x.children);
      if (!c) { c = { name: p, children: [] }; node.children!.push(c); }
      node = c;
    }
    node.children!.push({ name: f.path, file: f });
  }
  const hier = hierarchy<N>(root).sum((d) => d.file?.sloc ?? 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  treemap<N>().size([W, H]).paddingInner(1).paddingOuter(3).paddingTop((d) => (d.depth > 0 ? 14 : 3)).tile(treemapSquarify)(hier);
  const parts: string[] = [];
  for (const n of hier.descendants() as unknown as Array<{ x0: number; x1: number; y0: number; y1: number; depth: number; data: N; children?: unknown[] }>) {
    const w = n.x1 - n.x0, hh = n.y1 - n.y0;
    if (n.data.file) {
      const f = n.data.file;
      const sel = f.key === state.selected ? ' sel' : '';
      const label = w > 54 && hh > 16 ? `<text x="${n.x0 + 4}" y="${n.y0 + 13}" fill="${gradeInk(f.grade)}">${esc(f.path.split('/').pop()!)}</text>` : '';
      parts.push(`<g class="leaf${sel}${f.tier === 2 ? ' partial' : ''}" data-k="${esc(f.key)}"><rect x="${n.x0}" y="${n.y0}" width="${Math.max(0, w)}" height="${Math.max(0, hh)}" fill="${gradeColor(f.grade)}"/>${label}</g>`);
    } else if (n.depth > 0 && w > 40) {
      parts.push(`<text class="dir" x="${n.x0 + 3}" y="${n.y0 + 11}">${esc(n.data.name)}</text>`);
    }
  }
  treeEl.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Treemap: area is lines of code, color is grade"><defs><pattern id="stripes" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="8" fill="rgba(0,0,0,.22)"/></pattern></defs>${parts.join('')}</svg>`;
  treeEl.querySelectorAll<SVGGElement>('g.partial').forEach((g) => {
    const r = g.querySelector('rect')!;
    const o = r.cloneNode() as SVGRectElement;
    o.setAttribute('fill', 'url(#stripes)');
    g.insertBefore(o, r.nextSibling);
  });
}
treeEl.addEventListener('mousemove', (ev) => {
  const g = (ev.target as Element).closest('g.leaf') as SVGGElement | null;
  showTip(g?.dataset.k, ev.clientX, ev.clientY);
});
treeEl.addEventListener('mouseleave', () => showTip(undefined, 0, 0));
treeEl.addEventListener('click', (ev) => { const g = (ev.target as Element).closest('g.leaf') as SVGGElement | null; if (g?.dataset.k) select(g.dataset.k, false); });
treeEl.addEventListener('dblclick', (ev) => { const g = (ev.target as Element).closest('g.leaf') as SVGGElement | null; if (g?.dataset.k) send({ type: 'open', key: g.dataset.k }); });

/* =============================================================================
 * LIST (accessible table)
 * ========================================================================== */
const listEl = h('div', { class: 'list' });
const COLS: Array<[keyof UiFile, string, boolean]> = [
  ['path', 'File', false], ['lang', 'Language', false], ['grade', 'Grade', false], ['score', 'Score', true],
  ['sloc', 'Lines', true], ['debt', 'Debt', true], ['maxCC', 'Max complexity', true], ['maxCog', 'Max cognitive', true],
];
function renderList(): void {
  const files = visibleFiles().sort((a, b) => {
    const x = a[state.sort.col] as string | number, y = b[state.sort.col] as string | number;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * state.sort.dir;
  });
  const thead = h('tr');
  for (const [col, label, num] of COLS) {
    const active = state.sort.col === col;
    const th = h('th', { scope: 'col', class: num ? 'num' : undefined, 'aria-sort': active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none' });
    const b = h('button', { type: 'button' }, label + (active ? (state.sort.dir === 1 ? ' ▲' : ' ▼') : ''));
    b.addEventListener('click', () => {
      state.sort = { col, dir: active ? (state.sort.dir === 1 ? -1 : 1) : num ? -1 : 1 };
      renderList();
    });
    th.append(b);
    thead.append(th);
  }
  const tbody = h('tbody');
  for (const f of files) {
    const tr = h('tr', { tabindex: 0, class: f.key === state.selected ? 'sel' : undefined, 'data-k': f.key });
    tr.append(
      h('td', { class: 'path' }, f.path),
      h('td', {}, f.lang + (f.tier === 2 ? ' (partial)' : '')),
      h('td', {}, h('span', { class: 'chip', style: `background:${gradeColor(f.grade)};color:${gradeInk(f.grade)}` }, f.grade)),
      h('td', { class: 'num' }, String(f.score)), h('td', { class: 'num' }, f.sloc.toLocaleString('en')),
      h('td', { class: 'num' }, formatDebt(f.debt)), h('td', { class: 'num' }, String(f.maxCC)), h('td', { class: 'num' }, String(f.maxCog)));
    tr.addEventListener('click', () => select(f.key, false));
    tr.addEventListener('dblclick', () => send({ type: 'open', key: f.key }));
    tr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') select(f.key, false);
      if (ev.key.toLowerCase() === 'o') send({ type: 'open', key: f.key });
    });
    tbody.append(tr);
  }
  listEl.replaceChildren(h('table', {}, h('caption', { class: 'sr' }, 'Files with their grade and metrics'), h('thead', {}, thead), tbody));
}

/* =============================================================================
 * Tooltip, selection, keyboard
 * ========================================================================== */
function showTip(key: string | undefined, x: number, y: number): void {
  const f = key ? state.files.get(key) : undefined;
  if (!f) { tooltip.hidden = true; return; }
  fill(tooltip, 
    h('div', { class: 'tip-head' }, h('span', { class: 'chip', style: `background:${gradeColor(f.grade)};color:${gradeInk(f.grade)}` }, f.grade), h('b', {}, f.path.split('/').pop()!)),
    h('div', { class: 'tip-path' }, f.path),
    h('div', {}, `Score ${f.score}/100, debt ${formatDebt(f.debt)}, ${f.sloc.toLocaleString('en')} lines`),
    f.tier === 2 ? h('div', { class: 'muted' }, 'Partial analysis (no parser for this language)') : undefined,
    f.top ? h('div', { class: 'tip-top' }, f.top) : undefined);
  tooltip.hidden = false;
  const r = stage.getBoundingClientRect();
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let left = x - r.left + 14, top = y - r.top + 14;
  if (left + tw > r.width - 8) left = x - r.left - tw - 14;
  if (top + th > r.height - 8) top = y - r.top - th - 14;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function select(key: string, fly: boolean): void {
  state.selected = key;
  send({ type: 'detail', key });
  pyramid?.selectionChanged();
  if (fly) pyramid?.focusKey(key);
  if (state.view === 'treemap') renderTreemap();
  if (state.view === 'list') renderList();
}

/** Keyboard navigation in the 3D view (order = most debt first). */
function keyNav(ev: KeyboardEvent): void {
  const order = visibleFiles().sort((a, b) => b.debt - a.debt || a.path.localeCompare(b.path));
  if (!order.length) return;
  const idx = state.selected ? order.findIndex((f) => f.key === state.selected) : -1;
  const go = (i: number) => { ev.preventDefault(); select(order[(i + order.length) % order.length].key, true); };
  if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') go(idx + 1);
  else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') go(idx - 1);
  else if (ev.key === 'Home') go(0);
  else if (ev.key === 'Enter' && state.selected) select(state.selected, true);
  else if (ev.key.toLowerCase() === 'o' && state.selected) send({ type: 'open', key: state.selected });
}
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !drawer.hidden) closeDrawer(); });

/* =============================================================================
 * Detail drawer
 * ========================================================================== */
function closeDrawer(): void {
  drawer.hidden = true;
  state.selected = undefined;
  state.detail = undefined;
  pyramid?.selectionChanged();
  if (state.view === 'treemap') renderTreemap();
  if (state.view === 'list') renderList();
}

function renderDrawer(d: UiDetail): void {
  const f = d.file;
  const close = h('button', { type: 'button', class: 'icon', 'aria-label': 'Close details' }, '×');
  close.addEventListener('click', closeDrawer);
  const open = h('button', { type: 'button', class: 'btn primary' }, 'Open file');
  open.addEventListener('click', () => send({ type: 'open', key: f.key }));

  const fnRows = [...d.functions].sort((a, b) => b.cognitive - a.cognitive || b.cyclomatic - a.cyclomatic).map((fn) => {
    const tr = h('tr', { tabindex: 0, title: `Open ${fn.name} at line ${fn.startLine + 1}` },
      h('td', { class: 'fn' }, fn.name), h('td', {}, h('span', { class: 'chip', style: `background:${gradeColor(fn.grade)};color:${gradeInk(fn.grade)}` }, fn.grade)),
      h('td', { class: 'num' }, String(fn.cyclomatic)), h('td', { class: 'num' }, String(fn.cognitive)),
      h('td', { class: 'num' }, String(fn.maxNesting)), h('td', { class: 'num' }, String(fn.sloc)));
    const go = () => send({ type: 'open', key: f.key, line: fn.startLine });
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    return tr;
  });

  const findings = d.findings.filter((x) => x.severity !== 'info' || x.ruleId === 'CQ011').map((x) => {
    const line = h('button', { type: 'button', class: 'link' }, `line ${x.line + 1}`);
    line.addEventListener('click', () => send({ type: 'open', key: f.key, line: x.line }));
    return h('li', { class: `finding ${x.severity}` },
      h('div', { class: 'f-head' }, h('span', { class: `sev ${x.severity}` }, x.severity), h('code', {}, x.ruleId), line, h('span', { class: 'muted' }, x.debtText)),
      h('p', {}, x.message),
      h('details', {}, h('summary', {}, 'Why it matters and how to fix'), h('p', {}, x.why), h('ul', {}, ...x.fix.map((s) => h('li', {}, s)))));
  });

  fill(drawer, 
    h('div', { class: 'd-head' },
      h('span', { class: 'chip big', style: `background:${gradeColor(f.grade)};color:${gradeInk(f.grade)}` }, f.grade),
      h('div', { class: 'd-title' }, h('b', {}, f.path.split('/').pop()!), h('small', {}, f.path)), close),
    h('p', { class: 'd-stats' }, `Score ${f.score}/100. Debt ${formatDebt(f.debt)}. ${f.sloc.toLocaleString('en')} lines of ${f.lang}.`),
    d.note ? h('p', { class: 'note' }, d.note) : undefined,
    open,
    d.functions.length ? h('section', {}, h('h3', {}, `Functions (${d.functions.length})`),
      h('table', { class: 'fns' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Grade'), h('th', { class: 'num', title: 'Cyclomatic complexity' }, 'CC'),
        h('th', { class: 'num', title: 'Cognitive complexity' }, 'Cog'), h('th', { class: 'num', title: 'Max nesting' }, 'Nest'), h('th', { class: 'num' }, 'Lines'))), h('tbody', {}, ...fnRows))) : undefined,
    h('section', {}, h('h3', {}, findings.length ? `Findings (${findings.length})` : 'No findings'), h('ul', { class: 'findings' }, ...findings)));
  drawer.hidden = false;
}

/* =============================================================================
 * Render orchestration
 * ========================================================================== */
function renderChrome(): void {
  viewSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === state.view)));
  metricSel.disabled = state.view !== 'pyramid';
  resetBtn.hidden = worstBtn.hidden = state.view !== 'pyramid';
  const s = state.summary;
  if (s && (s.scanned || state.files.size)) {
    hallmark.replaceChildren(
      h('span', { class: 'chip', style: `background:${gradeColor(s.grade)};color:${gradeInk(s.grade)}` }, s.grade),
      h('span', {}, h('b', {}, String(s.score)), ' / 100'),
      h('span', { class: 'muted' }, s.debtText));
  } else hallmark.replaceChildren();
  scanBtn.textContent = s?.scanning ? 'Cancel scan' : 'Rescan';
  progress.hidden = !s?.scanning;
  if (s?.scanning) (progress.firstChild as HTMLElement).style.width = `${s.scanning.total ? (100 * s.scanning.done) / s.scanning.total : 3}%`;
  fill(legend, 
    ...(['A', 'B', 'C', 'D', 'E'] as Grade[]).map((g) => h('span', { class: 'chip', style: `background:${gradeColor(g)};color:${gradeInk(g)}` }, g)),
    h('span', {}, state.view === 'pyramid' ? `Height: ${METRICS.find((m) => m[0] === state.metric)![1].toLowerCase()}` : state.view === 'treemap' ? 'Area: lines of code' : ''),
    state.view !== 'list' ? h('span', { class: 'stripes-key' }, 'Striped: partial analysis') : undefined);
  legend.hidden = state.view === 'list';
}

function renderAll(changed: Set<string>): void {
  renderChrome();
  const files = visibleFiles();
  // Empty states are directions, not moods. Both messages may apply at once
  // (no WebGL AND nothing scanned): the scan button must never be hidden.
  let view = state.view;
  const msgs: Node[] = [];
  if (view === 'pyramid' && !getPyramid()) {
    view = 'treemap';
    msgs.push(h('p', {}, `3D view unavailable (${webglError ?? 'WebGL is disabled'}). Showing the treemap instead.`));
  }
  if (!files.length) {
    if (state.summary?.scanning) msgs.push(h('p', {}, 'Finding files…'));
    else {
      const b = h('button', { type: 'button', class: 'btn primary' }, 'Scan workspace');
      b.addEventListener('click', () => send({ type: 'command', id: 'scan' }));
      msgs.push(h('p', {}, 'No files analyzed yet.'), b);
    }
  }
  notice.hidden = msgs.length === 0;
  // With files present, a fallback note sits quietly at the top instead of
  // covering the treemap.
  notice.classList.toggle('corner', files.length > 0);
  notice.replaceChildren(...(msgs.length ? [h('div', {}, ...msgs)] : []));
  for (const el of [pyramid?.el, treeEl, listEl]) el?.remove();
  if (view === 'pyramid' && pyramid) { stage.prepend(pyramid.el); pyramid.setData(files, state.metric, changed); }
  else if (view === 'treemap') { stage.prepend(treeEl); renderTreemap(); }
  else { stage.prepend(listEl); renderList(); }
}

/** The pyramid redraws on every batch (cheap, instanced). The treemap and
 *  the list rebuild DOM, so during a scan they redraw at most every 300 ms. */
let pendingChanged = new Set<string>();
let renderTimer: number | undefined;
function scheduleRender(changed: Set<string>): void {
  if (state.view === 'pyramid') { renderAll(changed); return; }
  changed.forEach((k) => pendingChanged.add(k));
  if (renderTimer !== undefined) return;
  renderTimer = window.setTimeout(() => { renderTimer = undefined; const c = pendingChanged; pendingChanged = new Set(); renderAll(c); }, 300);
}

let treemapTimer: number | undefined;
new ResizeObserver(() => {
  if (state.view !== 'treemap') return;
  window.clearTimeout(treemapTimer);
  treemapTimer = window.setTimeout(renderTreemap, 120);
}).observe(stage);

/* =============================================================================
 * Messages from the host
 * ========================================================================== */
onHost((m) => {
  switch (m.type) {
    case 'init':
      setColorBlind(m.colorBlind);
      state.files = new Map(m.files.map((f) => [f.key, f]));
      state.summary = m.summary;
      renderAll(new Set());
      break;
    case 'files': {
      for (const k of m.remove) state.files.delete(k);
      for (const f of m.upsert) state.files.set(f.key, f);
      state.summary = m.summary;
      scheduleRender(new Set(m.upsert.map((f) => f.key)));
      // Keep an open drawer in sync with live edits of that file.
      if (state.selected && m.upsert.some((f) => f.key === state.selected)) send({ type: 'detail', key: state.selected });
      if (state.selected && m.remove.includes(state.selected)) closeDrawer();
      break;
    }
    case 'summary': state.summary = m.summary; renderChrome(); break;
    case 'detail': state.detail = m.detail; if (m.detail.file.key === state.selected || !state.selected) { state.selected = m.detail.file.key; renderDrawer(m.detail); } break;
    case 'focus': select(m.key, true); break;
    case 'palette': setColorBlind(m.colorBlind); renderAll(new Set()); break;
  }
});
send({ type: 'ready' });
