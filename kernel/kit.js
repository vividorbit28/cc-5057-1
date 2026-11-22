// 套件系统：加载套件文件（来源与参数随套件保存），注册模块与接口类型，
// 并对套件做静态校验——接口几何、配对矩阵、舱内连通、通行高度变体。
// 校验结论解释何时必须回溯：同尺寸接头通行高度不同，接口约束无法区分，
// 乘客路线被低矮件阻断时只能回溯更换变体。
import {
  MODULES, INTERFACE_TYPES, WALL_T,
  registerModules, registerInterfaceTypes, getKits,
  moduleShell, moduleAabb, ifaceGeom, stableStringify, defHash,
} from './modules.js';
import { buildNavGrid, bfs, worldToCell, NAV_CLEARANCE } from './validate.js';
import { hashSeed } from './rng.js';

const loadedKits = new Map();   // kitId -> { meta, findings }

// ---------- 单模块几何/连通实测 ----------

// 舱内连通实测：在指定通行净高下，每个门洞与导航点是否互达
export function moduleConnectivity(def, clearance = NAV_CLEARANCE) {
  const shell = moduleShell(def, 0, { x: 0, z: 0 });
  const aabb = moduleAabb(def, 0, { x: 0, z: 0 });
  const world = {
    walls: shell.walls, obstacles: shell.obstacles,
    placements: [{ aabb }], floors: [shell.floor],
  };
  const grid = buildNavGrid(world, clearance);
  if (!grid) return { ok: false, unreachable: ['无地板'] };
  const pts = def.interfaces.map((i) => {
    const g = ifaceGeom(def, i);
    return {
      name: `接口${i.id}`,
      x: g.center.x - g.dir.x * (WALL_T + 0.35),
      z: g.center.z - g.dir.z * (WALL_T + 0.35),
    };
  });
  const h = def.hatch ?? { x: def.size.x / 2, z: def.size.z / 2 };
  pts.push({ name: '导航点', x: h.x, z: h.z });
  if (pts.length === 0) return { ok: true, unreachable: [] };
  const start = worldToCell(grid, pts[0].x, pts[0].z);
  const { dist, ok } = bfs(grid, start);
  if (!ok) return { ok: false, unreachable: [pts[0].name] };
  const unreachable = [];
  for (const p of pts) {
    const c = worldToCell(grid, p.x, p.z);
    if (c.ix < 0 || c.iz < 0 || c.ix >= grid.nx || c.iz >= grid.nz || dist[c.ix * grid.nz + c.iz] < 0) {
      unreachable.push(p.name);
    }
  }
  return { ok: unreachable.length === 0, unreachable };
}

const clearanceCache = new Map();

// 通行高度实测：二分最大净高 H，使舱内各门洞与导航点在 H 下仍互达。
// 单门件（端盖/单门舱）不构成穿行路径，返回 null
export function measureModuleClearance(def) {
  if (def.interfaces.length < 2) return null;
  if (clearanceCache.has(def.hash)) return clearanceCache.get(def.hash);
  let lo = 0.5, hi = def.size.y;
  if (!moduleConnectivity(def, lo).ok) {
    clearanceCache.set(def.hash, 0);
    return 0;
  }
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    if (moduleConnectivity(def, mid).ok) lo = mid; else hi = mid;
  }
  const v = Math.round(lo * 10) / 10;
  clearanceCache.set(def.hash, v);
  return v;
}

// ---------- 套件注册 ----------

function compileKitModule(m) {
  return {
    type: m.type, label: m.label ?? m.type, size: m.size,
    interfaces: m.interfaces ?? [],
    tags: m.tags ?? [], obstacles: m.obstacles ?? [],
    hatch: m.hatch ?? null, slabs: m.slabs ?? [],
    incompatible: m.incompatible ?? null,
  };
}

// 单模块结构校验（注册前）：接口朝向/尺寸/边界
function staticModuleErrors(d, kitId) {
  const errs = [];
  const bad = (text) => errs.push({ level: 'error', code: 'module-structure', kit: kitId, modules: [d.type], text });
  if (!d.type || typeof d.type !== 'string') bad('模块缺少 type');
  if (MODULES[d.type]) bad(`模块类型 ${d.type} 已注册（部件身份冲突）`);
  for (const ax of ['x', 'y', 'z']) {
    if (!(d.size?.[ax] > 0)) bad(`尺寸 ${ax} 必须为正数`);
  }
  const ids = new Set();
  for (const i of d.interfaces ?? []) {
    if (ids.has(i.id)) bad(`接口 id ${i.id} 重复`);
    ids.add(i.id);
    const t = INTERFACE_TYPES[i.type];
    if (!t) { bad(`接口 ${i.id} 引用未声明的接口类型 ${i.type}`); continue; }
    if (!['N', 'S', 'W', 'E'].includes(i.face)) { bad(`接口 ${i.id} 朝向 ${i.face} 非法（须为 N/S/W/E）`); continue; }
    const span = (i.face === 'N' || i.face === 'S') ? d.size.x : d.size.z;
    if (!(i.u - t.w / 2 >= -1e-9 && i.u + t.w / 2 <= span + 1e-9)) {
      bad(`接口 ${i.id}（${i.type} 宽 ${t.w}m）在 ${i.face} 面 u=${i.u} 处超出门面（跨度 ${span}m）`);
    }
    if (t.h > d.size.y + 1e-9) bad(`接口 ${i.id} 高 ${t.h}m 超过舱高 ${d.size.y}m`);
  }
  if (d.hatch && !(d.hatch.x > 0 && d.hatch.x < d.size.x && d.hatch.z > 0 && d.hatch.z < d.size.z)) {
    bad('导航点 hatch 不在舱内');
  }
  for (const [kind, list] of [['obstacles', d.obstacles], ['slabs', d.slabs]]) {
    for (const b of list ?? []) {
      const inside = b.min.x >= -1e-9 && b.min.z >= -1e-9 && b.max.x <= d.size.x + 1e-9 && b.max.z <= d.size.z + 1e-9
        && b.min.x < b.max.x && b.min.y < b.max.y && b.min.z < b.max.z;
      if (!inside) bad(`${kind} 中存在越界或退化盒体 ${JSON.stringify(b)}`);
    }
  }
  if (d.incompatible && typeof d.incompatible.reason !== 'string') {
    bad('声明 incompatible 时必须给出 reason');
  }
  return errs;
}

// 注册套件数据（来源与参数随套件保存）。幂等：同 id 重复加载直接返回缓存。
export function registerKitData(data) {
  if (loadedKits.has(data?.id)) return loadedKits.get(data.id);
  const findings = [];
  if (data?.format !== 'orbital-station-kit/1') {
    findings.push({ level: 'error', code: 'kit-format', kit: data?.id ?? '?', text: `未知套件格式 ${data?.format}` });
    const res = { kit: null, findings, ok: false };
    return res;
  }
  const meta = {
    id: data.id, version: data.version ?? '0', label: data.label ?? data.id,
    source: data.source ?? null, params: data.params ?? {},
  };
  registerInterfaceTypes(data.interfaceTypes ?? {}, data.id);
  const defs = [];
  for (const m of data.modules ?? []) {
    const d = compileKitModule(m);
    const errs = staticModuleErrors(d, data.id);
    findings.push(...errs);
    if (!errs.some((e) => e.level === 'error')) defs.push(d);
  }
  registerModules(defs, meta);
  const validation = validateKit(data.id);
  findings.push(...validation.findings);
  const res = { kit: meta, findings, ok: !findings.some((f) => f.level === 'error'), validation };
  loadedKits.set(data.id, res);
  return res;
}

// ---------- 套件校验 ----------

// 接口配对矩阵：统计整个注册表中各接口类型的端口数
function pairingMatrix(kitModules) {
  const used = new Set();
  for (const d of kitModules) for (const i of d.interfaces) used.add(i.type);
  const matrix = [];
  for (const t of [...used].sort()) {
    let ports = 0;
    const owners = [];
    for (const def of Object.values(MODULES)) {
      const n = def.interfaces.filter((i) => i.type === t).length;
      if (n > 0) { ports += n; owners.push(def.type); }
    }
    matrix.push({ type: t, ports, owners });
  }
  return matrix;
}

// 同尺寸同接口分组：找出“可互换”但实测通行高度不同的接头对
function clearanceVariantPairs(kitModules) {
  const groups = new Map();
  for (const d of kitModules) {
    const sig = `${d.size.x}x${d.size.y}x${d.size.z}|`
      + d.interfaces.map((i) => `${i.type}@${i.face}:${i.u}`).sort().join(',');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(d);
  }
  const pairs = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const measured = group.map((d) => ({ def: d, clearance: measureModuleClearance(d) }));
    const vals = new Set(measured.map((m) => m.clearance));
    if (vals.size > 1) pairs.push(measured);
  }
  return pairs;
}

export function validateKit(kitId) {
  const meta = getKits().find((k) => k.id === kitId);
  const kitModules = Object.values(MODULES).filter((d) => d.kit === kitId);
  const findings = [];
  const clearance = {};
  const passengerClearance = meta?.params?.passengerClearance ?? NAV_CLEARANCE;

  // 来源与参数
  if (!meta?.source?.origin || !meta?.params || Object.keys(meta.params).length === 0) {
    findings.push({ level: 'warn', code: 'provenance', kit: kitId, text: `套件 ${kitId} 缺少来源或参数记录` });
  }

  // 舱内连通（乘客通行净高）
  for (const d of kitModules) {
    clearance[d.type] = measureModuleClearance(d);
    const conn = moduleConnectivity(d, passengerClearance);
    if (!conn.ok) {
      if (d.tags.includes('low-clearance')) {
        findings.push({
          level: 'info', code: 'low-clearance', kit: kitId, modules: [d.type],
          text: `${d.type} 在乘客净高 ${passengerClearance}m 下舱内不连通（实测通行高度 ${clearance[d.type]}m），已声明 low-clearance；位于乘客路线上时必须回溯更换高通行变体`,
        });
      } else {
        findings.push({
          level: 'error', code: 'module-disconnected', kit: kitId, modules: [d.type],
          text: `${d.type} 舱内不连通（净高 ${passengerClearance}m）：${conn.unreachable.join('、')} 不可达`,
        });
      }
    }
  }

  // 接口配对矩阵：无配合件的接口类型 => 故意不兼容部件必须声明原因
  for (const row of pairingMatrix(kitModules)) {
    if (row.ports >= 2) continue;
    const dead = kitModules.filter((d) => d.interfaces.some((i) => i.type === row.type));
    for (const d of dead) {
      if (d.incompatible?.reason) {
        findings.push({
          level: 'info', code: 'incompatible-declared', kit: kitId, modules: [d.type],
          text: `故意不兼容部件 ${d.type}（接口 ${row.type} 全注册表仅 ${row.ports} 个端口）：${d.incompatible.reason}`,
        });
      } else {
        findings.push({
          level: 'error', code: 'incompatible-undeclared', kit: kitId, modules: [d.type],
          text: `${d.type} 的接口类型 ${row.type} 在注册表中无配合件（端口 ${row.ports} 个），且未声明不兼容原因`,
        });
      }
    }
  }

  // 同尺寸同接口、通行高度不同的可互换接头对
  const pairs = clearanceVariantPairs(kitModules);
  for (const group of pairs) {
    const desc = group.map((m) => `${m.def.type}（${m.clearance}m）`).join(' 与 ');
    findings.push({
      level: 'warn', code: 'clearance-variant', kit: kitId,
      modules: group.map((m) => m.def.type),
      text: `可互换接头通行高度不同：${desc}——尺寸与接口完全相同，接口约束无法区分；当乘客路线必须穿越该连接而拿到低矮件时，求解器必须回溯更换变体`,
    });
  }

  return {
    kitId,
    ok: !findings.some((f) => f.level === 'error'),
    findings, clearance, pairs,
    matrix: pairingMatrix(kitModules),
  };
}

// ---------- 目录（供清单引用模块源文件） ----------

export function kitHash(kitId) {
  const defs = Object.values(MODULES).filter((d) => d.kit === kitId);
  const sig = defs.map((d) => `${d.type}:${d.hash}`).sort().join('|');
  return hashSeed(sig).toString(16).padStart(8, '0');
}

// 只收录实际用到的模块所属套件：来源、参数、部件身份哈希
export function kitCatalogFor(usedTypes) {
  const used = new Set(usedTypes);
  const out = [];
  for (const k of getKits()) {
    const defs = Object.values(MODULES).filter((d) => d.kit === k.id && used.has(d.type));
    if (defs.length === 0) continue;
    out.push({
      id: k.id, version: k.version, label: k.label,
      source: k.source, params: k.params,
      hash: kitHash(k.id),
      modules: Object.fromEntries(defs.map((d) => [d.type, d.hash])),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// 清单用的模块接口资料：不是美术网格，而是可拼装的接口数据
export function moduleTableFor(usedTypes) {
  const table = {};
  for (const t of [...new Set(usedTypes)].sort()) {
    const d = MODULES[t];
    if (!d) continue;
    table[t] = {
      kit: d.kit, hash: d.hash, label: d.label,
      size: d.size, tags: d.tags,
      clearance: measureModuleClearance(d),
      interfaces: d.interfaces.map((i) => ({
        id: i.id, type: i.type, face: i.face, u: i.u,
        w: INTERFACE_TYPES[i.type].w, h: INTERFACE_TYPES[i.type].h,
      })),
    };
  }
  return table;
}

export function kitContentString(kitId) {
  const defs = Object.values(MODULES).filter((d) => d.kit === kitId);
  return stableStringify(defs.map((d) => ({ type: d.type, hash: d.hash })).sort((a, b) => (a.type < b.type ? -1 : 1)));
}
