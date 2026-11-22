// 几何基础：Y 轴向上，绕 Y 轴 90° 整数旋转，AABB 碰撞
export const EPS = 1e-6;

// rot ∈ {0,1,2,3}，每次旋转 (x,z) -> (-z, x)
export function rotVec(v, rot) {
  let x = v.x, z = v.z;
  const y = v.y ?? 0;
  for (let i = 0; i < (rot & 3); i++) { const nx = -z, nz = x; x = nx; z = nz; }
  return { x, y, z };
}

export function rotSize(size, rot) {
  return (rot & 1) === 0 ? { ...size } : { x: size.z, y: size.y, z: size.x };
}

// 旋转后包围盒角点的最小偏移，使旋转后的盒子最小角落在 pos
export function rotOffset(size, rot) {
  switch (rot & 3) {
    case 0: return { x: 0, y: 0, z: 0 };
    case 1: return { x: size.z, y: 0, z: 0 };
    case 2: return { x: size.x, y: 0, z: size.z };
    default: return { x: 0, y: 0, z: size.x };
  }
}

// 模块局部点 -> 世界点（先旋转，再平移到 pos）
export function localToWorld(p, rot, pos, size) {
  const r = rotVec(p, rot);
  const o = rotOffset(size, rot);
  return { x: r.x + o.x + pos.x, y: (p.y ?? 0) + (pos.y ?? 0), z: r.z + o.z + pos.z };
}

export function worldToLocal(p, rot, pos, size) {
  // 逆变换：rot 的逆是 (4-rot)&3
  const inv = (4 - (rot & 3)) & 3;
  const q = { x: p.x - pos.x, y: (p.y ?? 0) - (pos.y ?? 0), z: p.z - pos.z };
  const o = rotOffset(size, rot);
  const q2 = { x: q.x - o.x, y: q.y - o.y, z: q.z - o.z };
  return rotVec(q2, inv);
}

export function aabbOf(size, rot, pos) {
  const s = rotSize(size, rot);
  const y = pos.y ?? 0;
  return {
    min: { x: pos.x, y, z: pos.z },
    max: { x: pos.x + s.x, y: y + s.y, z: pos.z + s.z },
  };
}

// 严格相交（贴面不算重叠）
export function overlaps(a, b) {
  return a.min.x < b.max.x - EPS && a.max.x > b.min.x + EPS
      && a.min.y < b.max.y - EPS && a.max.y > b.min.y + EPS
      && a.min.z < b.max.z - EPS && a.max.z > b.min.z + EPS;
}

export function containsPoint(b, p) {
  return p.x > b.min.x + EPS && p.x < b.max.x - EPS
      && p.y > b.min.y + EPS && p.y < b.max.y - EPS
      && p.z > b.min.z + EPS && p.z < b.max.z - EPS;
}

// 两个 AABB 的最小间距（相交或贴面为 0）
export function aabbDistance(a, b) {
  const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
  const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
  const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
  return Math.hypot(dx, dy, dz);
}

export function boxFromPoints(p1, p2) {
  return {
    min: { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), z: Math.min(p1.z, p2.z) },
    max: { x: Math.max(p1.x, p2.x), y: Math.max(p1.y, p2.y), z: Math.max(p1.z, p2.z) },
  };
}

export function transformBox(box, rot, pos, size) {
  const c1 = localToWorld(box.min, rot, pos, size);
  const c2 = localToWorld(box.max, rot, pos, size);
  return boxFromPoints(c1, c2);
}

export function boxInsideBounds(box, bounds) {
  return box.min.x >= bounds.min.x - EPS && box.max.x <= bounds.max.x + EPS
      && box.min.z >= bounds.min.z - EPS && box.max.z <= bounds.max.z + EPS
      && box.min.y >= 0 - EPS && box.max.y <= (bounds.max.y ?? 99) + EPS;
}

export function fmtVec(v) {
  return `(${v.x.toFixed(1)}, ${(v.y ?? 0).toFixed(1)}, ${v.z.toFixed(1)})`;
}
