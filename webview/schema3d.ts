/* =============================================================================
 * KASAUTI — webview/schema3d.ts   (v2.2 — 3D Code Map, VYUHA-style)
 * -----------------------------------------------------------------------------
 * WHAT:  The Code Map in 3D: glowing nodes floating in space —
 *          blue = project, grey = folders, A…E colour = files, small = functions
 *          lines = "contains", violet lines = "imports"
 *          a pulsing coloured halo = this file has a problem (red security,
 *          yellow AI mistakes, orange slow code)
 *        Drag to rotate, scroll to fly forward/back, right-drag to move.
 *        On open, the map builds itself node by node (the crawler idea, kept
 *        simple: one Replay button instead of six knobs).
 * WHY:   Kanak's 2.1 feedback: 2D felt flat and confusing, there were too many
 *        options, and "AI-risk" was not explained. VYUHA got its downloads by
 *        being simple and 3D. So: 3D with orbit/zoom, three buttons, and a
 *        "Problems found" panel in plain words that also filters the map.
 *        Reuses the tested graph logic (schemaGraph.ts); only drawing changed.
 * FLOW:  main.ts -> Schema3D.setData(files, changed) -> buildGraph -> 3D force
 *        layout -> Three.js (instanced spheres, glow points, line segments,
 *        HTML labels). Clicks go back to main.ts (drawer / open line / tooltip).
 *        If WebGL is missing, main.ts uses the 2D map (schema.ts) instead.
 * ========================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { UiFile } from '../src/snapshot';
import { PLAIN, PlainCat } from '../src/audit/plain';
import { buildGraph, crawlOrder, GNode, Graph } from './schemaGraph';
import { GOLD, gradeColor, h, prefersReducedMotion } from './common';
import type { SchemaHost } from './schema';
import LOGO from '../media/logo-mark.svg';

interface Body { x: number; y: number; z: number; vx: number; vy: number; vz: number; pinned?: boolean }
type RiskCat = 'security' | 'ai' | 'slow';

const BG = 0x05070d;
const SPRING: Record<string, number> = { 'root-dir': 60, 'root-file': 50, 'dir-dir': 46, 'dir-file': 34, 'file-fn': 13, import: 90 };
const CHARGE: Record<string, number> = { root: 700, dir: 420, file: 220, fn: 30 };

/** Soft round glow sprite drawn once on a canvas. */
function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.25, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Points whose size is in world units (so glows grow as you fly closer). */
function glowMaterial(tex: THREE.Texture, pulse: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, uScale: { value: 500 }, uTime: { value: 0 } },
    vertexShader: `attribute float size; attribute vec3 color; varying vec3 vColor; uniform float uScale; uniform float uTime;
      void main() { vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float s = size ${pulse ? '* (1.0 + 0.22 * sin(uTime * 3.0 + position.x))' : ''};
        gl_PointSize = s * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D map; varying vec3 vColor;
      void main() { vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vColor * t.a, t.a); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
}

export class Schema3D {
  readonly el: HTMLDivElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.5, 20000);
  private readonly controls: OrbitControls;
  private spheres: THREE.InstancedMesh;
  private readonly glow: THREE.Points;
  private readonly halo: THREE.Points;
  private readonly treeLines: THREE.LineSegments;
  private readonly importLines: THREE.LineSegments;
  private readonly hotLines: THREE.LineSegments;
  private readonly labelsEl: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly replayBtn: HTMLButtonElement;
  private readonly fnBtn: HTMLButtonElement;

  private graph: Graph = { nodes: new Map(), edges: [], adj: new Map() };
  private ids: string[] = [];                       // instance index -> node id
  private readonly bodies = new Map<string, Body>();
  private readonly appear = new Map<string, number>();  // 0..1 grow-in per node
  private files: UiFile[] = [];
  private readonly expanded = new Set<string>();
  private showFns = false;
  /** VYUHA-style view dock: node size multiplier and zoom relative to the framed view. */
  private sizeMul = 1;
  private baseDist = 500;
  private zoomInput!: HTMLInputElement;
  private sizeInput!: HTMLInputElement;
  private zoomOut!: HTMLSpanElement;
  private sizeOut!: HTMLSpanElement;
  private filter: RiskCat | undefined;
  private order: Array<{ id: string; via?: string }> = [];
  private revealed = 0;
  private alpha = 1;
  private hover: string | undefined;
  private fly: { target: THREE.Vector3; pos: THREE.Vector3 } | undefined;
  private framedOnce = false;
  private userMoved = false;
  private readonly pulses = new Map<string, number>();
  private readonly labelPool: HTMLDivElement[] = [];
  private last = performance.now();
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpC = new THREE.Color();
  private readonly tmpV = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  constructor(private readonly host: SchemaHost) {
    // ---- renderer + scene ----------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BG);
    this.scene.fog = new THREE.FogExp2(BG, 0.0011);
    this.scene.add(new THREE.HemisphereLight(0xe6ecff, 0x2a3040, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.8); key.position.set(200, 300, 400); this.scene.add(key);
    this.camera.position.set(0, 120, 520);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = !prefersReducedMotion();    // gentle spin until the user takes over
    this.controls.autoRotateSpeed = 0.5;
    this.controls.zoomSpeed = 1.1;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; this.userMoved = true; this.fly = undefined; });
    this.controls.addEventListener('change', () => this.syncZoom());

    // ---- scene objects ---------------------------------------------------------
    this.spheres = this.makeSpheres(512);
    const tex = glowTexture();
    const pts = (pulse: boolean) => { const g = new THREE.BufferGeometry(); const p = new THREE.Points(g, glowMaterial(tex, pulse)); p.frustumCulled = false; this.scene.add(p); return p; };
    this.glow = pts(false);
    this.halo = pts(true);
    const lines = (color: number, opacity: number) => { const l = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })); l.frustumCulled = false; this.scene.add(l); return l; };
    this.treeLines = lines(0x6b7593, 0.35);
    this.importLines = lines(0x7c8cff, 0.32);
    this.hotLines = lines(0xffffff, 0.9);

    // ---- overlay: title, labels, problems panel, 3 buttons, watermark ----------
    this.labelsEl = h('div', { class: 'map-labels', 'aria-hidden': 'true' });
    this.panel = h('div', { class: 'map-panel', 'aria-live': 'polite' });
    this.replayBtn = h('button', { type: 'button', class: 'sbtn' }, '▶ Replay');
    this.replayBtn.addEventListener('click', () => this.replay());
    this.fnBtn = h('button', { type: 'button', class: 'sbtn toggle', 'aria-pressed': 'false' }, 'ƒ Show functions');
    this.fnBtn.addEventListener('click', () => { this.showFns = !this.showFns; this.fnBtn.setAttribute('aria-pressed', String(this.showFns)); this.rebuild(new Set()); });
    const reset = h('button', { type: 'button', class: 'sbtn' }, '⟲ Reset view');
    reset.addEventListener('click', () => { this.userMoved = false; this.frame(); });
    // Zoom + Size sliders (VYUHA 4.0 "view dock"): zoom stays in sync with the wheel.
    this.zoomInput = h('input', { type: 'range', min: 0.3, max: 4, step: 0.05, value: 1, 'aria-label': 'Zoom' }) as HTMLInputElement;
    this.zoomInput.addEventListener('input', () => this.setZoom(Number(this.zoomInput.value)));
    this.sizeInput = h('input', { type: 'range', min: 0.4, max: 2.5, step: 0.05, value: 1, 'aria-label': 'Node size' }) as HTMLInputElement;
    this.sizeInput.addEventListener('input', () => this.setSize(Number(this.sizeInput.value)));
    this.zoomOut = h('span', { class: 'map-read' }, '1.0×');
    this.sizeOut = h('span', { class: 'map-read' }, '1.0×');
    const step = (label: string, fn: () => void) => { const b = h('button', { type: 'button', class: 'sbtn mini', 'aria-label': label }, label); b.addEventListener('click', fn); return b; };
    const bar = h('div', { class: 'map-bar' }, this.replayBtn, this.fnBtn, reset,
      h('label', { class: 'map-slider' }, 'Zoom', step('−', () => this.setZoom(this.zoomNow() / 1.25)), this.zoomInput, step('+', () => this.setZoom(this.zoomNow() * 1.25)), this.zoomOut),
      h('label', { class: 'map-slider' }, 'Size', this.sizeInput, this.sizeOut),
      h('span', { class: 'map-hint' }, 'Double-click a dot: jump to the code'));
    const mark = h('div', { class: 'schema-mark map-mark' });
    // kasauti-disable-next-line KP208 — our own bundled SVG, never user data
    mark.innerHTML = LOGO.replace(/<title>.*?<\/title>/, '');
    mark.append(h('span', {}, 'KASAUTI'));
    const title = h('div', { class: 'schema-title' }, h('b', {}, 'Code Map'), h('small', {}, 'every dot is a file · colour = grade · glowing ring = a problem · double-click = jump to code'));
    this.el = h('div', { class: 'schema map3d', tabindex: 0, 'aria-label': 'Code map in 3D. Use the List view for a keyboard-friendly table.' },
      this.renderer.domElement, this.labelsEl, title, this.panel, bar, mark);
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private makeSpheres(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 18, 14), new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.0 }), cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, new THREE.Color(0xffffff));
    m.count = 0;
    m.frustumCulled = false;
    this.scene.add(m);
    return m;
  }

  /* ========================================================================
   * Data
   * ====================================================================== */
  setData(files: UiFile[], changed: Set<string>): void { this.files = files; this.rebuild(changed); }

  private rebuild(changed: Set<string>): void {
    const done = this.order.length > 0 && this.revealed >= this.order.length;
    this.graph = buildGraph(this.files, { functions: this.showFns, expanded: this.expanded, maxNodes: 3500 });
    for (const id of [...this.bodies.keys()]) if (!this.graph.nodes.has(id)) { this.bodies.delete(id); this.appear.delete(id); }
    for (const n of this.graph.nodes.values()) {
      if (this.bodies.has(n.id)) continue;
      const p = n.parent ? this.bodies.get(n.parent) : undefined;
      // random point on a small sphere around the parent
      const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, d = 15 + Math.random() * 20, s = Math.sqrt(1 - u * u);
      this.bodies.set(n.id, { x: (p?.x ?? 0) + d * s * Math.cos(t), y: (p?.y ?? 0) + d * u, z: (p?.z ?? 0) + d * s * Math.sin(t), vx: 0, vy: 0, vz: 0, pinned: n.id === 'root' });
    }
    this.ids = [...this.graph.nodes.keys()];
    if (this.ids.length > this.spheres.instanceMatrix.count) {
      let cap = this.spheres.instanceMatrix.count; while (cap < this.ids.length) cap *= 2;
      this.scene.remove(this.spheres); this.spheres.dispose(); this.spheres = this.makeSpheres(cap);
    }
    this.order = crawlOrder(this.graph, 'bfs');
    if (done || prefersReducedMotion()) { this.revealed = this.order.length; for (const id of this.ids) if (!this.appear.has(id)) this.appear.set(id, prefersReducedMotion() ? 1 : 0); }
    for (const k of changed) this.pulses.set('file:' + k, performance.now());
    this.alpha = Math.max(this.alpha, changed.size || !done ? 0.7 : 0.3);
    this.renderPanel();
  }

  private replay(): void {
    this.revealed = 0;
    this.appear.clear();                 // every node hides, then grows back in crawl order
    this.userMoved = false;
    this.framedOnce = false;
    this.controls.autoRotate = !prefersReducedMotion();
  }

  selectionChanged(): void { this.renderPanel(); }

  focusKey(key: string): void {
    const b = this.bodies.get('file:' + key);
    if (!b) return;
    const target = new THREE.Vector3(b.x, b.y, b.z);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.fly = { target, pos: target.clone().add(dir.multiplyScalar(140)) };
    this.controls.autoRotate = false;
  }

  /* ---- view dock ------------------------------------------------------------ */
  /** Current zoom as "× the framed view" (1 = everything fits). */
  private zoomNow(): number { return this.baseDist / Math.max(1, this.camera.position.distanceTo(this.controls.target)); }
  private setZoom(z: number): void {
    z = Math.min(4, Math.max(0.3, z));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).add(dir.multiplyScalar(this.baseDist / z));
    this.controls.autoRotate = false; this.fly = undefined;
    this.syncZoom();
  }
  private syncZoom(): void {
    const z = this.zoomNow();
    this.zoomInput.value = String(z.toFixed(2));
    this.zoomOut.textContent = `${z.toFixed(1)}×`;
  }
  private setSize(s: number): void {
    this.sizeMul = Math.min(2.5, Math.max(0.4, s));
    this.sizeInput.value = String(this.sizeMul);
    this.sizeOut.textContent = `${this.sizeMul.toFixed(1)}×`;
  }

  /** Point the camera so every visible node fits. */
  frame(): void {
    const vis = this.ids.filter((id) => (this.appear.get(id) ?? 0) > 0).map((id) => this.bodies.get(id)!);
    if (!vis.length) return;
    const c = new THREE.Vector3();
    for (const b of vis) c.add(this.tmpV.set(b.x, b.y, b.z));
    c.divideScalar(vis.length);
    let r = 30;
    for (const b of vis) r = Math.max(r, c.distanceTo(this.tmpV.set(b.x, b.y, b.z)));
    const dist = (r * 1.15) / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.baseDist = dist;
    this.fly = { target: c, pos: c.clone().add(dir.multiplyScalar(dist)) };
    (this.scene.fog as THREE.FogExp2).density = 0.55 / (dist + r);
  }

  /* ========================================================================
   * Loop
   * ====================================================================== */
  private tick(): void {
    if (!this.el.isConnected) return;
    const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.alpha > 0.01) { this.simulate(); this.alpha *= 0.985; }
    // Build-up animation: reveal in crawl order, ~6 s whatever the project size.
    if (this.revealed < this.order.length) {
      const rate = Math.max(10, this.order.length / 6);
      const from = Math.floor(this.revealed);
      this.revealed = Math.min(this.order.length, this.revealed + rate * dt);
      for (let i = from; i < Math.floor(this.revealed); i++) if (!this.appear.has(this.order[i].id)) this.appear.set(this.order[i].id, 0);
    }
    for (const [id, a] of this.appear) if (a < 1) this.appear.set(id, Math.min(1, a + dt * 2.5));
    if (!this.framedOnce && this.revealed >= this.order.length && this.alpha < 0.08 && this.order.length) { this.framedOnce = true; if (!this.userMoved) this.frame(); }
    if (this.fly) {
      const e = prefersReducedMotion() ? 1 : 0.08;
      this.controls.target.lerp(this.fly.target, e);
      this.camera.position.lerp(this.fly.pos, e);
      if (this.camera.position.distanceTo(this.fly.pos) < 0.5) this.fly = undefined;
    }
    this.controls.update();
    for (const [id, t0] of this.pulses) if (now - t0 > 1400) this.pulses.delete(id);
    this.updateScene(now);
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  }

  /** 3D force layout: springs on edges, short-range repulsion through a grid. */
  private simulate(): void {
    const a = this.alpha, nodes = this.graph.nodes;
    for (const e of this.graph.edges) {
      const p = this.bodies.get(e.a), q = this.bodies.get(e.b);
      if (!p || !q) continue;
      const len = e.kind === 'import' ? SPRING.import : SPRING[`${nodes.get(e.a)!.kind}-${nodes.get(e.b)!.kind}`] ?? 40;
      const str = e.kind === 'import' ? 0.004 : 0.1;
      const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z, d = Math.hypot(dx, dy, dz) || 0.01;
      const f = ((d - len) / d) * str * a;
      if (!q.pinned) { q.vx -= dx * f; q.vy -= dy * f; q.vz -= dz * f; }
      if (!p.pinned) { p.vx += dx * f; p.vy += dy * f; p.vz += dz * f; }
    }
    const CELL = 80, grid = new Map<string, string[]>();
    const cell = (b: Body) => `${Math.floor(b.x / CELL)},${Math.floor(b.y / CELL)},${Math.floor(b.z / CELL)}`;
    for (const [id, b] of this.bodies) { const k = cell(b); const c = grid.get(k); if (c) c.push(id); else grid.set(k, [id]); }
    for (const [id, b] of this.bodies) {
      if (b.pinned) continue;
      const qa = CHARGE[nodes.get(id)?.kind ?? 'fn'];
      const cx = Math.floor(b.x / CELL), cy = Math.floor(b.y / CELL), cz = Math.floor(b.z / CELL);
      for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 1; z <= cz + 1; z++) {
        for (const other of grid.get(`${x},${y},${z}`) ?? []) {
          if (other === id) continue;
          const o = this.bodies.get(other)!;
          let dx = b.x - o.x, dy = b.y - o.y, dz = b.z - o.z, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; d2 = 0.75; }
          if (d2 > CELL * CELL * 3) continue;
          const f = ((qa + CHARGE[nodes.get(other)?.kind ?? 'fn']) / 2) * a / (d2 * Math.sqrt(d2) * 0.04 + d2);
          b.vx += dx * f; b.vy += dy * f; b.vz += dz * f;
        }
      }
      b.vx -= b.x * 0.002 * a; b.vy -= b.y * 0.002 * a; b.vz -= b.z * 0.002 * a;
    }
    for (const b of this.bodies.values()) {
      if (b.pinned) { b.vx = b.vy = b.vz = 0; continue; }
      b.vx *= 0.6; b.vy *= 0.6; b.vz *= 0.6;
      const lim = (v: number) => Math.max(-25, Math.min(25, v));
      b.x += lim(b.vx); b.y += lim(b.vy); b.z += lim(b.vz);
    }
  }

  /** Which problem halo a node gets (most dangerous wins). */
  private risk(n: GNode): RiskCat | undefined {
    if (!n.kp) return undefined;
    const [slow, sec, ai] = n.kp;
    if (this.filter) return ({ security: sec, ai, slow } as const)[this.filter] ? this.filter : undefined;
    return sec ? 'security' : ai ? 'ai' : slow ? 'slow' : undefined;
  }

  private updateScene(now: number): void {
    const sel = this.host.selected();
    const focus = this.hover ?? (sel ? 'file:' + sel : undefined);
    const near = new Set<string>(focus ? [focus, ...(this.graph.adj.get(focus) ?? [])] : []);
    const glowPos: number[] = [], glowCol: number[] = [], glowSize: number[] = [];
    const haloPos: number[] = [], haloCol: number[] = [], haloSize: number[] = [];
    this.spheres.count = this.ids.length;
    this.ids.forEach((id, i) => {
      const n = this.graph.nodes.get(id)!, b = this.bodies.get(id)!;
      const ap = this.appear.get(id) ?? 0;
      const ease = ap * ap * (3 - 2 * ap);
      const t0 = this.pulses.get(id);
      const bump = t0 !== undefined ? 1 + 0.6 * Math.sin(Math.min(1, (now - t0) / 1400) * Math.PI) : 1;
      const r = n.r * 0.55 * ease * bump * this.sizeMul;
      this.tmpM.makeScale(r, r, r).setPosition(b.x, b.y, b.z);
      this.spheres.setMatrixAt(i, this.tmpM);
      const base = n.kind === 'root' ? '#4f8cff' : n.kind === 'dir' ? '#8b93a7' : n.grade ? gradeColor(n.grade) : '#8b93a7';
      const risk = this.risk(n);
      const dim = (this.filter && n.kind !== 'root' && n.kind !== 'dir' && !risk) || (focus && !near.has(id)) ? 0.18 : 1;
      this.spheres.setColorAt(i, this.tmpC.set(base).multiplyScalar(dim));
      if (ease <= 0) return;
      this.tmpC.set(base).multiplyScalar(0.55 * dim);
      glowPos.push(b.x, b.y, b.z); glowCol.push(this.tmpC.r, this.tmpC.g, this.tmpC.b); glowSize.push(n.r * 3.2 * ease * this.sizeMul);
      if (risk && n.kind !== 'dir') {
        this.tmpC.set(PLAIN[risk].color);
        haloPos.push(b.x, b.y, b.z); haloCol.push(this.tmpC.r, this.tmpC.g, this.tmpC.b); haloSize.push(n.r * 5.5 * ease * this.sizeMul);
      }
      if (n.kind === 'file' && n.key === sel) { this.tmpC.set(GOLD); haloPos.push(b.x, b.y, b.z); haloCol.push(this.tmpC.r, this.tmpC.g, this.tmpC.b); haloSize.push(n.r * 7 * this.sizeMul); }
    });
    this.spheres.instanceMatrix.needsUpdate = true;
    if (this.spheres.instanceColor) this.spheres.instanceColor.needsUpdate = true;
    const setPts = (p: THREE.Points, pos: number[], col: number[], size: number[]) => {
      const g = p.geometry;
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('size', new THREE.Float32BufferAttribute(size, 1));
    };
    setPts(this.glow, glowPos, glowCol, glowSize);
    setPts(this.halo, haloPos, haloCol, haloSize);
    (this.halo.material as THREE.ShaderMaterial).uniforms.uTime.value = now / 1000;

    const tree: number[] = [], imp: number[] = [], hot: number[] = [];
    for (const e of this.graph.edges) {
      if ((this.appear.get(e.a) ?? 0) <= 0 || (this.appear.get(e.b) ?? 0) <= 0) continue;
      const p = this.bodies.get(e.a)!, q = this.bodies.get(e.b)!;
      const seg = [p.x, p.y, p.z, q.x, q.y, q.z];
      if (focus && (e.a === focus || e.b === focus)) hot.push(...seg);
      else if (e.kind === 'import') imp.push(...seg); else tree.push(...seg);
    }
    this.treeLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(tree, 3));
    this.importLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(imp, 3));
    this.hotLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(hot, 3));
    (this.treeLines.material as THREE.LineBasicMaterial).opacity = focus || this.filter ? 0.12 : 0.35;
    (this.importLines.material as THREE.LineBasicMaterial).opacity = focus || this.filter ? 0.1 : 0.32;
  }

  /** HTML labels for the most important visible nodes, never overlapping. */
  private updateLabels(): void {
    const w = this.renderer.domElement.clientWidth, hgt = this.renderer.domElement.clientHeight;
    const sel = this.host.selected();
    const focus = this.hover ?? (sel ? 'file:' + sel : undefined);
    const near = new Set<string>(focus ? [focus, ...(this.graph.adj.get(focus) ?? [])] : []);
    const cands: Array<{ n: GNode; x: number; y: number; prio: number; depth: number }> = [];
    for (const id of this.ids) {
      if ((this.appear.get(id) ?? 0) < 0.6) continue;
      const n = this.graph.nodes.get(id)!, b = this.bodies.get(id)!;
      this.tmpV.set(b.x, b.y, b.z).project(this.camera);
      if (this.tmpV.z > 1 || Math.abs(this.tmpV.x) > 1.05 || Math.abs(this.tmpV.y) > 1.05) continue;
      const risk = this.risk(n);
      const prio = id === focus ? 0 : near.has(id) ? 1 : n.kind === 'root' ? 2 : risk && n.kind === 'file' ? 3 : n.kind === 'dir' ? 4 : n.kind === 'file' ? 6 - Math.min(1.5, n.r / 8) : 9;
      if (this.filter && !risk && prio > 2) continue;
      cands.push({ n, x: (this.tmpV.x * 0.5 + 0.5) * w, y: (-this.tmpV.y * 0.5 + 0.5) * hgt, prio, depth: this.tmpV.z });
    }
    cands.sort((a, b) => a.prio - b.prio || a.depth - b.depth);
    const placed: Array<[number, number, number, number]> = [];
    let used = 0;
    for (const c of cands) {
      if (used >= 45 && c.prio > 1) break;
      const text = c.n.label.length > 30 ? c.n.label.slice(0, 29) + '…' : c.n.label;
      const bw = text.length * 6.8 + 14, bh = 18, bx = c.x + 8, by = c.y - bh / 2;
      if (c.prio > 1 && placed.some((p) => bx < p[0] + p[2] && p[0] < bx + bw && by < p[1] + p[3] && p[1] < by + bh)) continue;
      placed.push([bx, by, bw, bh]);
      let el = this.labelPool[used];
      if (!el) { el = h('div', { class: 'tag3d' }); this.labelPool.push(el); this.labelsEl.append(el); }
      const risk = this.risk(c.n);
      el.textContent = text;
      el.className = `tag3d ${c.n.kind}${c.prio === 0 ? ' focus' : ''}`;
      el.style.borderColor = risk ? PLAIN[risk].color : c.n.kind === 'file' && c.n.grade ? gradeColor(c.n.grade) : '';
      el.style.transform = `translate(${Math.round(bx)}px, ${Math.round(by)}px)`;
      el.hidden = false;
      used++;
    }
    for (let i = used; i < this.labelPool.length; i++) this.labelPool[i].hidden = true;
  }

  /** "Problems found" in plain words. Each row filters the map to that problem. */
  private panelSig = '';
  private renderPanel(): void {
    const count: Record<RiskCat, { files: number; issues: number }> = { security: { files: 0, issues: 0 }, ai: { files: 0, issues: 0 }, slow: { files: 0, issues: 0 } };
    for (const f of this.files) if (f.kp) {
      const [slow, sec, ai] = f.kp;
      if (sec) { count.security.files++; count.security.issues += sec; }
      if (ai) { count.ai.files++; count.ai.issues += ai; }
      if (slow) { count.slow.files++; count.slow.issues += slow; }
    }
    const sig = JSON.stringify([count, this.filter, this.files.length]);
    if (sig === this.panelSig) return;
    this.panelSig = sig;
    const row = (cat: RiskCat) => {
      const c = count[cat], p = PLAIN[cat];
      const b = h('button', { type: 'button', class: `prow${this.filter === cat ? ' on' : ''}`, title: p.explain, 'aria-pressed': String(this.filter === cat), disabled: c.files === 0 },
        h('i', { style: `background:${p.color};box-shadow:0 0 8px ${p.color}` }),
        h('span', { class: 'pname' }, p.label),
        h('b', {}, c.files ? `${c.files} file${c.files > 1 ? 's' : ''}` : 'none'));
      b.addEventListener('click', () => { this.filter = this.filter === cat ? undefined : cat; this.renderPanel(); });
      return [b, h('p', { class: 'pexplain' }, p.explain)];
    };
    this.panel.replaceChildren(
      h('div', { class: 'phead' }, 'Problems found', h('small', {}, `${this.files.length} files checked`)),
      ...(['security', 'ai', 'slow'] as RiskCat[]).flatMap(row),
      this.filter ? (() => { const b = h('button', { type: 'button', class: 'sbtn pall' }, 'Show all files'); b.addEventListener('click', () => { this.filter = undefined; this.renderPanel(); }); return b; })()
        : h('p', { class: 'ptip' }, 'Click a group to highlight those files. Click a file to see exactly what is wrong and how to fix it.'));
  }

  /* ========================================================================
   * Input
   * ====================================================================== */
  private resize(): void {
    const w = this.el.clientWidth, hgt = this.el.clientHeight;
    if (!w || !hgt) return;
    this.renderer.setSize(w, hgt, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    const scale = hgt / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    for (const p of [this.glow, this.halo]) (p.material as THREE.ShaderMaterial).uniforms.uScale.value = scale;
  }

  private pick(ev: MouseEvent): string | undefined {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.spheres, false).find((x) => x.instanceId !== undefined && (this.appear.get(this.ids[x.instanceId!]) ?? 0) > 0.3);
    if (hit) return this.ids[hit.instanceId!];
    // Small nodes are hard to hit: accept the closest node within 10 px.
    let best: string | undefined, bestD = 10;
    for (const id of this.ids) {
      const b = this.bodies.get(id)!;
      this.tmpV.set(b.x, b.y, b.z).project(this.camera);
      if (this.tmpV.z > 1) continue;
      const d = Math.hypot((this.tmpV.x * 0.5 + 0.5) * r.width - (ev.clientX - r.left), (-this.tmpV.y * 0.5 + 0.5) * r.height - (ev.clientY - r.top));
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  private bindInput(): void {
    const c = this.renderer.domElement;
    let down: { x: number; y: number } | undefined;
    c.addEventListener('pointermove', (ev) => {
      if (ev.buttons) return;                                  // orbiting: no hover work
      const id = this.pick(ev);
      this.hover = id;
      const n = id ? this.graph.nodes.get(id) : undefined;
      c.style.cursor = n && n.kind !== 'root' ? 'pointer' : 'grab';
      if (n?.kind === 'file') this.host.tip(n.key, ev.clientX, ev.clientY);
      else if (n?.kind === 'fn') this.host.tip(undefined, ev.clientX, ev.clientY, `${n.label} — line ${n.line! + 1}. Double-click to jump to it.`);
      else if (n?.kind === 'dir') this.host.tip(undefined, ev.clientX, ev.clientY, `Folder ${n.label}`);
      else this.host.tip(undefined, 0, 0);
    });
    c.addEventListener('pointerleave', () => { this.hover = undefined; this.host.tip(undefined, 0, 0); });
    c.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
    c.addEventListener('pointerup', (ev) => {
      if (!down || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5 || ev.button !== 0) return;
      const n = this.graph.nodes.get(this.pick(ev) ?? '');
      if (n?.kind === 'file' && n.key) this.host.select(n.key);
      else if (n?.kind === 'fn' && n.key) this.host.open(n.key, n.line);
    });
    // VYUHA's "double-tap to see the code": jump straight to the line.
    c.addEventListener('dblclick', (ev) => {
      const n = this.graph.nodes.get(this.pick(ev) ?? '');
      if (n?.key && (n.kind === 'file' || n.kind === 'fn')) this.host.open(n.key, n.kind === 'fn' ? n.line : undefined);
    });
    // VYUHA keys: + / - zoom, ] / [ size, 0 back to 1.0×.
    this.el.addEventListener('keydown', (ev) => {
      const k = (ev as KeyboardEvent).key;
      if (k === '+' || k === '=') this.setZoom(this.zoomNow() * 1.25);
      else if (k === '-') this.setZoom(this.zoomNow() / 1.25);
      else if (k === ']') this.setSize(this.sizeMul + 0.1);
      else if (k === '[') this.setSize(this.sizeMul - 0.1);
      else if (k === '0') { this.setSize(1); this.setZoom(1); }
    });
  }
}
