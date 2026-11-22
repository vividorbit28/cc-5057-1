// 验收：从实际装配结果重建碰撞体与可通行表面，做几何碰撞与导航通路检查。
// 门洞是墙体上的真实缺口；接口不匹配会被报出，不做视觉遮挡。
import { MODULES, moduleShell, hatchWorld, WALL_T } from './modules.js';
import { overlaps, containsPoint, aabbDistance, EPS } from './geom.js';

export const NAV_CELL = 0.5;

// 由装配结果重建世界：碰撞体（墙/障碍）、可通行地板、接口、连接
export function buildWorld(state) {
  const placements = [...state.placements.values()];
  const world = { walls: [], floors: [], ceilings: [], obstacles: [], placements, boxes: [] };
  for (const p of placements) {
    const def = MODULES[p.type];
    const shell = moduleShell(def, p.rot, p.pos);
    world.walls.push(...shell.walls.map((b) => ({ ...b, uid: p.uid })));
    world.floors.push({ ...shell.floor, uid: p.uid });
    world.ceilings.push({ ...shell.ceiling, uid: p.uid });
    world.obstacles.push(...shell.obstacles.map((b) => ({ ...b, uid: p.uid })));
  }
  return world;
}

// 导航网格：可通行 = 在某模块地板内 且 不被墙体/设备碰撞体阻挡
export function buildNavGrid(world) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of world.placements) {
    minX = Math.min(minX, p.aabb.min.x); maxX = Math.max(maxX, p.aabb.max.x);
    minZ = Math.min(minZ, p.aabb.min.z); maxZ = Math.max(maxZ, p.aabb.max.z);
  }
  if (!isFinite(minX)) return null;
  const c = NAV_CELL;
  const nx = Math.ceil((maxX - minX) / c), nz = Math.ceil((maxZ - minZ) / c);
  const solid = [...world.walls, ...world.obstacles];
  const walk = new Uint8Array(nx * nz);
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const x0 = minX + ix * c, z0 = minZ + iz * c;
      const cell = { min: { x: x0, y: 0.01, z: z0 }, max: { x: x0 + c, y: 2.0, z: z0 + c } };
      const cx = x0 + c / 2, cz = z0 + c / 2;
      const onFloor = world.placements.some((p) =>
        cx > p.aabb.min.x + EPS && cx < p.aabb.max.x - EPS
        && cz > p.aabb.min.z + EPS && cz < p.aabb.max.z - EPS);
      if (!onFloor) continue;
      const blocked = solid.some((b) => overlaps(cell, b));
      if (!blocked) walk[ix * nz + iz] = 1;
    }
  }
  return { minX, minZ, nx, nz, c, walk };
}

export function worldToCell(grid, x, z) {
  return { ix: Math.floor((x - grid.minX) / grid.c), iz: Math.floor((z - grid.minZ) / grid.c) };
}

export function bfs(grid, start) {
  const { nx, nz, walk } = grid;
  const dist = new Int32Array(nx * nz).fill(-1);
  const prev = new Int32Array(nx * nz).fill(-1);
  const si = start.ix * nz + start.iz;
  if (start.ix < 0 || start.iz < 0 || start.ix >= nx || start.iz >= nz || !walk[si]) return { dist, prev, ok: false };
  dist[si] = 0;
  const q = [si];
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const cx = Math.floor(cur / nz), cz = cur % nz;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = cx + dx, az = cz + dz;
      if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
      const ai = ax * nz + az;
      if (!walk[ai] || dist[ai] !== -1) continue;
      dist[ai] = dist[cur] + 1;
      prev[ai] = cur;
      q.push(ai);
    }
  }
  return { dist, prev, ok: true };
}

function targetPoints(state, spec) {
  const tags = spec.targets ?? [];
  const pts = [];
  for (const p of state.placements.values()) {
    if (p.tags.some((t) => tags.includes(t))) {
      const def = MODULES[p.type];
      pts.push({ uid: p.uid, type: p.type, tag: p.tags.find((t) => tags.includes(t)), ...hatchWorld(def, p.rot, p.pos) });
    }
  }
  return pts;
}

export function entrancePoint(state) {
  for (const p of state.placements.values()) {
    if (p.tags.includes('entrance')) {
      const def = MODULES[p.type];
      return { uid: p.uid, ...hatchWorld(def, p.rot, p.pos) };
    }
  }
  return null;
}

// 乘客路线：入口 -> 各目标舱导航点的网格 BFS
export function validateNav(state, spec) {
  const world = buildWorld(state);
  const grid = buildNavGrid(world);
  const unreachable = [];
  const paths = [];
  if (!grid) return { ok: true, unreachable, paths, grid: null };
  const ent = entrancePoint(state);
  if (!ent) return { ok: true, unreachable, paths, grid };
  const start = worldToCell(grid, ent.x, ent.z);
  const { dist, prev, ok } = bfs(grid, start);
  if (!ok) return { ok: false, unreachable: ['入口出生点被阻挡'], paths, grid };
  for (const t of targetPoints(state, spec)) {
    const c = worldToCell(grid, t.x, t.z);
    const idx = c.ix * grid.nz + c.iz;
    if (c.ix < 0 || c.iz < 0 || c.ix >= grid.nx || c.iz >= grid.nz || dist[idx] < 0) {
      unreachable.push(`${t.type}(${t.uid})`);
      continue;
    }
    // 还原路径（供界面绘制乘客路线）
    const cells = [];
    let cur = idx;
    while (cur !== -1) {
      cells.push({ ix: Math.floor(cur / grid.nz), iz: cur % grid.nz });
      cur = prev[cur];
    }
    cells.reverse();
    paths.push({ to: `${t.type}(${t.uid})`, tag: t.tag, length: dist[idx] * grid.c, cells });
  }
  return { ok: unreachable.length === 0, unreachable, paths, grid };
}

// 全场景验收：几何碰撞 + 接口审计 + 间距 + 导航通路
export function validateScene(state, spec = state.spec ?? {}) {
  const errors = [];
  const warnings = [];
  const placements = [...state.placements.values()];

  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      if (overlaps(placements[i].aabb, placements[j].aabb)) {
        errors.push(`几何碰撞：${placements[i].type}(${placements[i].uid}) 与 ${placements[j].type}(${placements[j].uid}) 体积重叠`);
      }
    }
  }

  // 接口审计：相邻模块门洞必须类型匹配且双向对齐；不匹配即错误，不得遮挡掩盖
  const used = new Set();
  for (const c of state.connections) {
    used.add(`${c.a.uid}:${c.a.ifaceId}`);
    used.add(`${c.b.uid}:${c.b.ifaceId}`);
  }
  let connCount = 0;
  for (const c of state.connections) {
    const a = state.placements.get(c.a.uid), b = state.placements.get(c.b.uid);
    if (!a || !b) { errors.push(`连接指向缺失模块`); continue; }
    const wa = a.ifaces.find((w) => w.ifaceId === c.a.ifaceId);
    const wb = b.ifaces.find((w) => w.ifaceId === c.b.ifaceId);
    if (!wa || !wb) { errors.push(`连接指向缺失接口`); continue; }
    const aligned = Math.abs(wa.center.x - wb.center.x) < EPS && Math.abs(wa.center.z - wb.center.z) < EPS
      && wa.dir.x === -wb.dir.x && wa.dir.z === -wb.dir.z && wa.type === wb.type;
    if (!aligned) errors.push(`接口错位：${a.type}:${c.a.ifaceId} 与 ${b.type}:${c.b.ifaceId} 类型/朝向/边界不重合`);
    else connCount += 1;
  }
  const openEnds = [];
  for (const p of placements) {
    for (const w of p.ifaces) {
      if (!used.has(`${p.uid}:${w.ifaceId}`)) openEnds.push({ uid: p.uid, type: p.type, ...w });
    }
  }
  if (!spec.allowOpenEnds && openEnds.length > 0) {
    errors.push(`未封闭开放端 ${openEnds.length} 个`);
  } else if (openEnds.length > 0) {
    warnings.push(`开放端 ${openEnds.length} 个（手动模式允许，可作为可行连接锚点）`);
  }

  for (const rule of spec.spacing ?? []) {
    const as = placements.filter((p) => p.tags.includes(rule.a));
    const bs = placements.filter((p) => p.tags.includes(rule.b));
    for (const a of as) for (const b of bs) {
      const d = aabbDistance(a.aabb, b.aabb);
      if (d < rule.min - EPS) errors.push(`区域间距不足：${rule.a}↔${rule.b} ${d.toFixed(1)}m < ${rule.min}m`);
    }
  }

  const nav = validateNav(state, spec);
  for (const u of nav.unreachable) errors.push(`导航通路断裂：${u}`);

  return {
    ok: errors.length === 0,
    errors, warnings,
    openEnds,
    nav: { paths: nav.paths, unreachable: nav.unreachable },
    stats: {
      modules: placements.length,
      connections: connCount,
      openEnds: openEnds.length,
    },
  };
}
