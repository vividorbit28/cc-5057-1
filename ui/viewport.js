// 软件三维视窗：透视投影 + 画家算法，渲染真实装配体（墙/地板/设备/门洞）。
// 门洞是墙体上的真实缺口——这里只画装配出来的碰撞体与可通行表面，不做任何遮挡修饰。
export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { yaw: 0.75, pitch: 0.62, dist: 46, target: { x: 2, y: 0, z: 8 } };
    this.boxes = [];    // {min,max,color,alpha,uid,skipTop,edge}
    this.polylines = []; // {pts,color,width,y}
    this.frames = [];   // 门框 {center,dir,w,h,color}
    this.labels = [];   // {p,text,color}
    this.grid = null;   // {minX,maxX,minZ,maxZ,step}
    this.onPick = null;
    this.onDropPoint = null;
    this._bindInput();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(320, Math.floor(r.width * devicePixelRatio));
    this.canvas.height = Math.max(240, Math.floor(r.height * devicePixelRatio));
  }

  _basis() {
    const { yaw, pitch, dist, target } = this.cam;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const pos = {
      x: target.x + dist * cp * sy,
      y: target.y + dist * sp,
      z: target.z + dist * cp * cy,
    };
    const fwd = norm({ x: target.x - pos.x, y: target.y - pos.y, z: target.z - pos.z });
    const right = norm(cross(fwd, { x: 0, y: 1, z: 0 }));
    const up = cross(right, fwd);
    return { pos, fwd, right, up };
  }

  project(p, basis = this._basis()) {
    const v = { x: p.x - basis.pos.x, y: p.y - basis.pos.y, z: p.z - basis.pos.z };
    const cz = dot(v, basis.fwd);
    if (cz < 0.15) return null;
    const cx = dot(v, basis.right);
    const cy = dot(v, basis.up);
    const focal = this.canvas.height * 0.85;
    return {
      x: this.canvas.width / 2 + (cx * focal) / cz,
      y: this.canvas.height / 2 - (cy * focal) / cz,
      z: cz,
    };
  }

  rayFromScreen(sx, sy) {
    const basis = this._basis();
    const focal = this.canvas.height * 0.85;
    const cx = (sx * devicePixelRatio - this.canvas.width / 2) / focal;
    const cy = (this.canvas.height / 2 - sy * devicePixelRatio) / focal;
    const dir = norm({
      x: basis.fwd.x + basis.right.x * cx + basis.up.x * cy,
      y: basis.fwd.y + basis.right.y * cx + basis.up.y * cy,
      z: basis.fwd.z + basis.right.z * cx + basis.up.z * cy,
    });
    return { origin: basis.pos, dir };
  }

  groundPoint(sx, sy) {
    const { origin, dir } = this.rayFromScreen(sx, sy);
    if (Math.abs(dir.y) < 1e-6) return null;
    const t = -origin.y / dir.y;
    if (t < 0) return null;
    return { x: origin.x + dir.x * t, y: 0, z: origin.z + dir.z * t };
  }

  pick(sx, sy) {
    const { origin, dir } = this.rayFromScreen(sx, sy);
    let best = null;
    for (const b of this.boxes) {
      if (!b.uid) continue;
      const t = rayAabb(origin, dir, b);
      if (t !== null && (best === null || t < best.t)) best = { t, uid: b.uid };
    }
    return best?.uid ?? null;
  }

  _bindInput() {
    let down = null, moved = false;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, yaw: this.cam.yaw, pitch: this.cam.pitch };
      moved = false;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      this.cam.yaw = down.yaw - dx * 0.008;
      this.cam.pitch = Math.min(1.45, Math.max(0.15, down.pitch + dy * 0.008));
      this.render();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (down && !moved && this.onPick) {
        const r = this.canvas.getBoundingClientRect();
        this.onPick(this.pick(e.clientX - r.left, e.clientY - r.top));
      }
      down = null;
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = Math.min(160, Math.max(8, this.cam.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
      this.render();
    }, { passive: false });
  }

  render() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(0, 0, W, H);
    const basis = this._basis();

    // 地面网格
    if (this.grid) {
      const g = this.grid;
      ctx.strokeStyle = 'rgba(120,144,156,0.25)';
      ctx.lineWidth = 1;
      for (let x = g.minX; x <= g.maxX + 1e-6; x += g.step) this._line({ x, y: 0, z: g.minZ }, { x, y: 0, z: g.maxZ }, basis);
      for (let z = g.minZ; z <= g.maxZ + 1e-6; z += g.step) this._line({ x: g.minX, y: 0, z }, { x: g.maxX, y: 0, z }, basis);
    }

    // 收集所有面，按深度排序（画家算法）
    const faces = [];
    for (const b of this.boxes) {
      faces.push(...boxFaces(b, basis));
    }
    faces.sort((a, b) => b.depth - a.depth);
    for (const f of faces) {
      const pts = f.corners.map((c) => this.project(c, basis));
      if (pts.some((p) => !p)) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = shade(f.color, f.light, f.alpha);
      ctx.fill();
      if (f.edge) {
        ctx.strokeStyle = f.edge;
        ctx.lineWidth = devicePixelRatio;
        ctx.stroke();
      }
    }

    // 门框（开放端/可行连接高亮）
    for (const fr of this.frames) {
      const inPlane = fr.dir.x === 0 ? { x: 1, z: 0 } : { x: 0, z: 1 };
      const hw = fr.w / 2;
      const c = fr.center;
      const cs = [
        { x: c.x - inPlane.x * hw, y: 0, z: c.z - inPlane.z * hw },
        { x: c.x + inPlane.x * hw, y: 0, z: c.z + inPlane.z * hw },
        { x: c.x + inPlane.x * hw, y: fr.h, z: c.z + inPlane.z * hw },
        { x: c.x - inPlane.x * hw, y: fr.h, z: c.z - inPlane.z * hw },
      ];
      ctx.strokeStyle = fr.color;
      ctx.lineWidth = 2.5 * devicePixelRatio;
      ctx.beginPath();
      let started = false;
      for (const p of [...cs, cs[0]]) {
        const q = this.project(p, basis);
        if (!q) { started = false; continue; }
        if (!started) { ctx.moveTo(q.x, q.y); started = true; } else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    }

    // 折线（乘客路线等）
    for (const pl of this.polylines) {
      ctx.strokeStyle = pl.color;
      ctx.lineWidth = (pl.width ?? 2) * devicePixelRatio;
      ctx.beginPath();
      let started = false;
      for (const p of pl.pts) {
        const q = this.project({ x: p.x, y: pl.y ?? 0.12, z: p.z }, basis);
        if (!q) { started = false; continue; }
        if (!started) { ctx.moveTo(q.x, q.y); started = true; } else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    }

    // 标注
    ctx.font = `${12 * devicePixelRatio}px monospace`;
    for (const l of this.labels) {
      const q = this.project(l.p, basis);
      if (!q) continue;
      ctx.fillStyle = l.color ?? '#e0e0e0';
      ctx.fillText(l.text, q.x + 4, q.y - 4);
    }
  }

  _line(a, b, basis) {
    const { ctx } = this;
    const pa = this.project(a, basis), pb = this.project(b, basis);
    if (!pa || !pb) return;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
}

function norm(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

function rayAabb(o, d, b) {
  let t0 = 0, t1 = Infinity;
  for (const ax of ['x', 'y', 'z']) {
    const inv = 1 / (d[ax] || 1e-12);
    let ta = (b.min[ax] - o[ax]) * inv;
    let tb = (b.max[ax] - o[ax]) * inv;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0;
}

function boxFaces(b, basis) {
  const { min, max } = b;
  const c = {
    x0: min.x, y0: min.y, z0: min.z,
    x1: max.x, y1: max.y, z1: max.z,
  };
  const defs = [
    { n: { x: 0, y: 1, z: 0 }, corners: [{ x: c.x0, y: c.y1, z: c.z0 }, { x: c.x1, y: c.y1, z: c.z0 }, { x: c.x1, y: c.y1, z: c.z1 }, { x: c.x0, y: c.y1, z: c.z1 }], top: true },
    { n: { x: 0, y: -1, z: 0 }, corners: [{ x: c.x0, y: c.y0, z: c.z0 }, { x: c.x0, y: c.y0, z: c.z1 }, { x: c.x1, y: c.y0, z: c.z1 }, { x: c.x1, y: c.y0, z: c.z0 }] },
    { n: { x: 0, z: -1, y: 0 }, corners: [{ x: c.x0, y: c.y0, z: c.z0 }, { x: c.x1, y: c.y0, z: c.z0 }, { x: c.x1, y: c.y1, z: c.z0 }, { x: c.x0, y: c.y1, z: c.z0 }] },
    { n: { x: 0, z: 1, y: 0 }, corners: [{ x: c.x0, y: c.y0, z: c.z1 }, { x: c.x0, y: c.y1, z: c.z1 }, { x: c.x1, y: c.y1, z: c.z1 }, { x: c.x1, y: c.y0, z: c.z1 }] },
    { n: { x: -1, y: 0, z: 0 }, corners: [{ x: c.x0, y: c.y0, z: c.z0 }, { x: c.x0, y: c.y1, z: c.z0 }, { x: c.x0, y: c.y1, z: c.z1 }, { x: c.x0, y: c.y0, z: c.z1 }] },
    { n: { x: 1, y: 0, z: 0 }, corners: [{ x: c.x1, y: c.y0, z: c.z0 }, { x: c.x1, y: c.y0, z: c.z1 }, { x: c.x1, y: c.y1, z: c.z1 }, { x: c.x1, y: c.y1, z: c.z0 }] },
  ];
  const light = { x: 0.5, y: 0.8, z: 0.3 };
  const out = [];
  for (const f of defs) {
    if (f.top && b.skipTop) continue;
    const center = {
      x: (f.corners[0].x + f.corners[2].x) / 2,
      y: (f.corners[0].y + f.corners[2].y) / 2,
      z: (f.corners[0].z + f.corners[2].z) / 2,
    };
    const toCam = { x: basis.pos.x - center.x, y: basis.pos.y - center.y, z: basis.pos.z - center.z };
    if (dot(f.n, toCam) <= 0) continue; // 背面剔除
    const depth = dot({ x: center.x - basis.pos.x, y: center.y - basis.pos.y, z: center.z - basis.pos.z }, basis.fwd);
    const l = 0.45 + 0.55 * Math.max(0, dot(f.n, light));
    out.push({ corners: f.corners, depth, color: b.color, light: l, alpha: b.alpha ?? 1, edge: b.edge });
  }
  return out;
}

function shade(hex, light, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * light);
  const g = Math.min(255, ((n >> 8) & 255) * light);
  const b = Math.min(255, (n & 255) * light);
  return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
}
