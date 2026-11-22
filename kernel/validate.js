// 验收：从实际装配结果重建碰撞体与可通行表面，做几何碰撞与导航通路检查。
// 门洞是墙体上的真实缺口；接口不匹配会被报出，不做视觉遮挡。
// 导航不可达时给出阻断证据：哪些模块（部件身份）的哪些构造挡住了连通区域边界。
import { MODULES, moduleShell, hatchWorld, WALL_T } from './modules.js';
import { overlaps, containsPoint, aabbDistance, EPS } from './geom.js';

export const NAV_CELL = 0.5;
export const NAV_CLEARANCE = 2.0;    // 乘客通行所需净高（米）

// 由装配结果重建世界：碰撞体（墙/障碍）、可通行地板、夹层板、接口、连接
export function buildWorld(state) {
  const placements = [...state.placements.values()];
  const world = { walls: [], floors: [], ceilings: [], obstacles: [], slabs: [], placements, boxes: [] };
  for (const p of placements) {
    const def = MODULES[p.type];
    const shell = moduleShell(def, p.rot, p.pos);
    world.walls.push(...shell.walls.map((b) => ({ ...b, uid: p.uid })));
    world.floors.push({ ...shell.floor, uid: p.uid });
    world.ceilings.push({ ...shell.ceiling, uid: p.uid });
    world.obstacles.push(...shell.obstacles.map((b) => ({ ...b, uid: p.uid })));
    world.slabs.push(...(shell.slabs ?? []).map((b) => ({ ...b, uid: p.uid })));
  }
  return world;
}

// 导航网格：可通行 = 在某模块地板内 且 不被墙体/设备碰撞体阻挡
// clearance：通行所需净高；低于该净高的悬空构造（如低矮管道）会阻断网格
export function buildNavGrid(world, clearance = NAV_CLEARANCE) {
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
      const cell = { min: { x: x0, y: 0.01, z: z0 }, max: { x: x0 + c, y: clearance, z: z0 + c } };
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

// 阻断证据：连通区域边界上被碰撞体挡住的网格，归并到模块（部件身份）与构造标签。
// 只统计落在某模块地板上的受阻格；模块自身墙体包住自身地板是正常外壳，不计入——
// 计入的是障碍物（设备/管道）与他人构造的侵入
function computeBlockers(grid, world, dist, state) {
  const { nx, nz, c, minX, minZ, walk } = grid;
  const solids = [
    ...world.obstacles.map((s) => ({ ...s, ownCounts: true })),
    ...world.walls.map((s) => ({ ...s, ownCounts: false })),
  ];
  const agg = new Map();
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      if (dist[ix * nz + iz] < 0) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ax = ix + dx, az = iz + dz;
        if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
        const ai = ax * nz + az;
        if (walk[ai] || dist[ai] >= 0) continue;
        const cx = minX + (ax + 0.5) * c, cz = minZ + (az + 0.5) * c;
        const floorOwners = new Set(world.placements
          .filter((p) => cx > p.aabb.min.x + EPS && cx < p.aabb.max.x - EPS
            && cz > p.aabb.min.z + EPS && cz < p.aabb.max.z - EPS)
          .map((p) => p.uid));
        if (floorOwners.size === 0) continue;
        const cell = {
          min: { x: minX + ax * c, y: 0.01, z: minZ + az * c },
          max: { x: minX + (ax + 1) * c, y: NAV_CLEARANCE, z: minZ + (az + 1) * c },
        };
        for (const s of solids) {
          if (!s.uid || !overlaps(cell, s)) continue;
          if (!s.ownCounts && floorOwners.has(s.uid)) continue; // 自身墙壳不算证据
          let e = agg.get(s.uid);
          if (!e) {
            e = { uid: s.uid, type: state.placements.get(s.uid)?.type ?? '?', labels: new Set(), cells: 0 };
            agg.set(s.uid, e);
          }
          if (s.label) e.labels.add(s.label);
          e.cells += 1;
        }
      }
    }
  }
  return [...agg.values()]
    .map((e) => ({ uid: e.uid, type: e.type, labels: [...e.labels], cells: e.cells }))
    .sort((a, b) => b.cells - a.cells)
    .slice(0, 8);
}

function cellDist(grid, dist, x, z) {
  const c = worldToCell(grid, x, z);
  if (c.ix < 0 || c.iz < 0 || c.ix >= grid.nx || c.iz >= grid.nz) return -1;
  return dist[c.ix * grid.nz + c.iz];
}

// 封死判定：不可达目标舱是否已不可能再恢复连通。
// 导航区域只能经区域内的开放端向外生长；若入口区域或目标区域已无开放端，
// 任何后续模块都无法把两者连通——此时继续搜索必然失败，应立即回溯。
export function sealedUnreachableTargets(state, spec) {
  const world = buildWorld(state);
  const grid = buildNavGrid(world);
  if (!grid) return [];
  const ent = entrancePoint(state);
  if (!ent) return [];
  const { dist, ok } = bfs(grid, worldToCell(grid, ent.x, ent.z));
  if (!ok) return [];
  const unreachable = targetPoints(state, spec)
    .filter((t) => cellDist(grid, dist, t.x, t.z) < 0);
  if (unreachable.length === 0) return [];
  const openInside = state.openEnds.map((e) => ({
    x: e.center.x - e.dir.x * (WALL_T + 0.35),
    z: e.center.z - e.dir.z * (WALL_T + 0.35),
  }));
  const entranceHasOpen = openInside.some((p) => cellDist(grid, dist, p.x, p.z) >= 0);
  if (!entranceHasOpen) return unreachable.map((t) => `${t.type}(${t.uid})`);
  const sealed = [];
  for (const t of unreachable) {
    const { dist: tdist, ok: tok } = bfs(grid, worldToCell(grid, t.x, t.z));
    if (!tok) { sealed.push(`${t.type}(${t.uid})`); continue; }
    const targetHasOpen = openInside.some((p) => cellDist(grid, tdist, p.x, p.z) >= 0);
    if (!targetHasOpen) sealed.push(`${t.type}(${t.uid})`);
  }
  return sealed;
}

// 乘客路线：入口 -> 各目标舱导航点的网格 BFS
export function validateNav(state, spec) {
  const world = buildWorld(state);
  const grid = buildNavGrid(world);
  const unreachable = [];
  const paths = [];
  const blockedBy = [];
  if (!grid) return { ok: true, unreachable, paths, blockedBy, grid: null };
  const ent = entrancePoint(state);
  if (!ent) return { ok: true, unreachable, paths, blockedBy, grid };
  const start = worldToCell(grid, ent.x, ent.z);
  const { dist, prev, ok } = bfs(grid, start);
  if (!ok) return { ok: false, unreachable: ['入口出生点被阻挡'], paths, blockedBy, grid };
  const toWorld = (cell) => ({
    x: grid.minX + (cell.ix + 0.5) * grid.c,
    z: grid.minZ + (cell.iz + 0.5) * grid.c,
  });
  for (const t of targetPoints(state, spec)) {
    const c = worldToCell(grid, t.x, t.z);
    const idx = c.ix * grid.nz + c.iz;
    if (c.ix < 0 || c.iz < 0 || c.ix >= grid.nx || c.iz >= grid.nz || dist[idx] < 0) {
      unreachable.push(`${t.type}(${t.uid})`);
      continue;
    }
    // 还原路径（供界面绘制乘客路线、清单保存演示路线）
    const cells = [];
    let cur = idx;
    while (cur !== -1) {
      cells.push({ ix: Math.floor(cur / grid.nz), iz: cur % grid.nz });
      cur = prev[cur];
    }
    cells.reverse();
    paths.push({ to: `${t.type}(${t.uid})`, tag: t.tag, length: dist[idx] * grid.c, cells, pts: cells.map(toWorld) });
  }
  if (unreachable.length > 0) {
    blockedBy.push(...computeBlockers(grid, world, dist, state));
  }
  return { ok: unreachable.length === 0, unreachable, paths, blockedBy, grid };
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
    nav: { paths: nav.paths, unreachable: nav.unreachable, blockedBy: nav.blockedBy },
    stats: {
      modules: placements.length,
      connections: connCount,
      openEnds: openEnds.length,
    },
  };
}
