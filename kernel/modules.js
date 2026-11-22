// 模块库：自制走廊、设备舱、连接件。每个模块定义接口（类型/朝向/位置）、
// 外壳（墙体真实开门洞）、内部障碍物（设备）与导航目标点。
import { rotVec, rotSize, localToWorld, transformBox, aabbOf } from './geom.js';

export const WALL_T = 0.25;          // 墙厚（内缩于模块包围盒）
export const INTERFACE_TYPES = {
  C2: { w: 2.0, h: 2.4, label: '标准人员接口 C2' },
  C4: { w: 3.2, h: 3.0, label: '宽幅货运接口 C4' },
};

// face: N(z=min) S(z=max) W(x=min) E(x=max)；u 为门面内中心偏移（米）
function ifaceLocal(def, i) {
  const s = def.size;
  switch (i.face) {
    case 'N': return { dir: { x: 0, z: -1 }, center: { x: i.u, y: 0, z: 0 } };
    case 'S': return { dir: { x: 0, z: 1 }, center: { x: i.u, y: 0, z: s.z } };
    case 'W': return { dir: { x: -1, z: 0 }, center: { x: 0, y: 0, z: i.u } };
    case 'E': return { dir: { x: 1, z: 0 }, center: { x: s.x, y: 0, z: i.u } };
    default: throw new Error(`bad face ${i.face}`);
  }
}

function def(type, label, size, interfaces, extra = {}) {
  const d = { type, label, size, interfaces, tags: extra.tags ?? [], obstacles: extra.obstacles ?? [], hatch: extra.hatch ?? null };
  d.doorCount = interfaces.length;
  return d;
}

export const MODULES = Object.fromEntries([
  def('airlock', '入口气闸', { x: 4, y: 3, z: 4 }, [
    { id: 'A', type: 'C2', face: 'S', u: 2 },
  ], { tags: ['entrance'], hatch: { x: 2, z: 2 } }),

  def('corr-straight', '直走廊', { x: 3, y: 3, z: 6 }, [
    { id: 'A', type: 'C2', face: 'N', u: 1.5 },
    { id: 'B', type: 'C2', face: 'S', u: 1.5 },
  ], { tags: ['corridor'] }),

  def('corr-corner', '转角走廊', { x: 4, y: 3, z: 4 }, [
    { id: 'A', type: 'C2', face: 'N', u: 2 },
    { id: 'B', type: 'C2', face: 'E', u: 2 },
  ], { tags: ['corridor'] }),

  def('corr-t', '三通走廊', { x: 4, y: 3, z: 4 }, [
    { id: 'A', type: 'C2', face: 'N', u: 2 },
    { id: 'B', type: 'C2', face: 'E', u: 2 },
    { id: 'C', type: 'C2', face: 'W', u: 2 },
  ], { tags: ['corridor'] }),

  def('corr-x', '四通走廊', { x: 4, y: 3, z: 4 }, [
    { id: 'A', type: 'C2', face: 'N', u: 2 },
    { id: 'B', type: 'C2', face: 'E', u: 2 },
    { id: 'C', type: 'C2', face: 'W', u: 2 },
    { id: 'D', type: 'C2', face: 'S', u: 2 },
  ], { tags: ['corridor'] }),

  def('connector', '连接气闸', { x: 3, y: 3, z: 3 }, [
    { id: 'A', type: 'C2', face: 'N', u: 1.5 },
    { id: 'B', type: 'C2', face: 'S', u: 1.5 },
  ], { tags: ['connector'] }),

  def('corr-wide', '宽走廊', { x: 4, y: 3.6, z: 6 }, [
    { id: 'A', type: 'C4', face: 'N', u: 2 },
    { id: 'B', type: 'C4', face: 'S', u: 2 },
  ], { tags: ['corridor'] }),

  def('adapter', '变径接头', { x: 4, y: 3.6, z: 3 }, [
    { id: 'A', type: 'C2', face: 'N', u: 2 },
    { id: 'B', type: 'C4', face: 'S', u: 2 },
  ], { tags: ['connector'] }),

  def('bay-med', '医疗舱', { x: 6, y: 3.2, z: 6 }, [
    { id: 'A', type: 'C2', face: 'N', u: 3 },
  ], {
    tags: ['medbay'], hatch: { x: 3, z: 4.5 },
    obstacles: [
      { min: { x: 0.8, y: 0, z: 1.5 }, max: { x: 1.8, y: 0.9, z: 4.5 }, label: '诊疗台' },
      { min: { x: 4.2, y: 0, z: 1.5 }, max: { x: 5.2, y: 0.9, z: 4.5 }, label: '设备柜' },
    ],
  }),

  def('bay-reactor', '反应堆舱', { x: 8, y: 4, z: 8 }, [
    { id: 'A', type: 'C2', face: 'N', u: 4 },
  ], {
    tags: ['reactor'], hatch: { x: 4, z: 6.5 },
    obstacles: [
      { min: { x: 3, y: 0, z: 3 }, max: { x: 5, y: 3.5, z: 5 }, label: '反应堆芯' },
    ],
  }),

  def('bay-hydro', '水培舱', { x: 8, y: 3.2, z: 6 }, [
    { id: 'A', type: 'C2', face: 'N', u: 4 },
  ], {
    tags: ['hydro'], hatch: { x: 4, z: 5.2 },
    obstacles: [
      { min: { x: 1, y: 0, z: 2 }, max: { x: 7, y: 1, z: 2.8 }, label: '种植槽A' },
      { min: { x: 1, y: 0, z: 4 }, max: { x: 7, y: 1, z: 4.8 }, label: '种植槽B' },
    ],
  }),

  def('hangar', '机库', { x: 10, y: 5, z: 12 }, [
    { id: 'A', type: 'C4', face: 'N', u: 5 },
  ], { tags: ['hangar'], hatch: { x: 5, z: 8 } }),

  def('cap', '端盖', { x: 3, y: 3, z: 1 }, [
    { id: 'A', type: 'C2', face: 'S', u: 1.5 },
  ], { tags: ['cap'] }),
].map((d) => [d.type, d]));

// 模块某接口的局部几何（中心点/外法向/门面内轴向）
export function ifaceGeom(def, iface) {
  const loc = ifaceLocal(def, iface);
  const t = INTERFACE_TYPES[iface.type];
  const inPlane = (iface.face === 'N' || iface.face === 'S') ? { x: 1, z: 0 } : { x: 0, z: 1 };
  return { ...loc, w: t.w, h: t.h, inPlane };
}

// 世界坐标接口
export function worldIface(def, iface, rot, pos) {
  const g = ifaceGeom(def, iface);
  const c = localToWorld(g.center, rot, pos, def.size);
  const d = rotVec(g.dir, rot);
  return {
    ifaceId: iface.id, type: iface.type,
    center: { x: c.x, y: 0, z: c.z }, dir: { x: d.x, z: d.z },
    w: g.w, h: g.h,
  };
}

export function worldIfaces(def, rot, pos) {
  return def.interfaces.map((i) => worldIface(def, i, rot, pos));
}

// 生成模块外壳：地板、天花、四面墙（门洞是墙上真实的缺口，不做视觉遮挡）
export function moduleShell(def, rot, pos) {
  const s = def.size;
  const T = WALL_T;
  const walls = [];
  const faces = ['N', 'S', 'W', 'E'];
  for (const f of faces) {
    // 面墙的局部包围盒（内缩墙厚）
    let box;
    if (f === 'N') box = { min: { x: 0, y: 0, z: 0 }, max: { x: s.x, y: s.y, z: T } };
    if (f === 'S') box = { min: { x: 0, y: 0, z: s.z - T }, max: { x: s.x, y: s.y, z: s.z } };
    if (f === 'W') box = { min: { x: 0, y: 0, z: 0 }, max: { x: T, y: s.y, z: s.z } };
    if (f === 'E') box = { min: { x: s.x - T, y: 0, z: 0 }, max: { x: s.x, y: s.y, z: s.z } };
    const doors = def.interfaces.filter((i) => i.face === f)
      .map((i) => ({ u: i.u, ...INTERFACE_TYPES[i.type] }))
      .sort((a, b) => a.u - b.u);
    const along = (f === 'N' || f === 'S') ? 'x' : 'z';
    const span = along === 'x' ? s.x : s.z;
    // 沿门面方向按门洞切分墙体；门洞上方加过梁
    let cursor = 0;
    const segs = [];
    for (const d of doors) {
      const a = d.u - d.w / 2, b = d.u + d.w / 2;
      if (a > cursor) segs.push([cursor, a, 0, s.y]);
      segs.push([a, b, d.h, s.y]); // 过梁
      cursor = b;
    }
    if (cursor < span) segs.push([cursor, span, 0, s.y]);
    for (const [a, b, y0, y1] of segs) {
      if (b - a < 1e-6 || y1 - y0 < 1e-6) continue;
      const seg = { min: { ...box.min }, max: { ...box.max } };
      seg.min[along] = a; seg.max[along] = b;
      seg.min.y = y0; seg.max.y = y1;
      walls.push(transformBox(seg, rot, pos, s));
    }
  }
  const floor = transformBox({ min: { x: 0, y: -0.2, z: 0 }, max: { x: s.x, y: 0, z: s.z } }, rot, pos, s);
  const ceiling = transformBox({ min: { x: 0, y: s.y, z: 0 }, max: { x: s.x, y: s.y + 0.2, z: s.z } }, rot, pos, s);
  const obstacles = def.obstacles.map((o) => ({ ...transformBox(o, rot, pos, s), label: o.label }));
  return { walls, floor, ceiling, obstacles };
}

export function moduleAabb(def, rot, pos) {
  return aabbOf(def.size, rot, pos);
}

export function hatchWorld(def, rot, pos) {
  const h = def.hatch ?? { x: def.size.x / 2, z: def.size.z / 2 };
  const w = localToWorld({ x: h.x, y: 0, z: h.z }, rot, pos, def.size);
  return { x: w.x, z: w.z };
}
