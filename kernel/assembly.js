// 装配状态与约束内核：求解器、穷举核对、UI 手动拼装共用。
// 约束：接口类型/朝向/边界尺寸匹配、不重叠、边界内、区域间距、门洞不被墙堵死。
import { MODULES, worldIfaces, moduleAabb, WALL_T } from './modules.js';
import { overlaps, aabbDistance, boxInsideBounds, EPS, fmtVec } from './geom.js';

let uidCounter = 1;
export function resetUid(n = 1) { uidCounter = n; }

export function endKey(w) {
  return `${w.center.x.toFixed(2)},${w.center.z.toFixed(2)},${w.dir.x},${w.dir.z}`;
}

export function makePlacement(type, rot, pos) {
  const def = MODULES[type];
  const p = {
    uid: `m${uidCounter++}`,
    type, rot, pos: { x: pos.x, y: 0, z: pos.z },
    tags: def.tags,
    aabb: moduleAabb(def, rot, pos),
    ifaces: worldIfaces(def, rot, pos),
  };
  return p;
}

export function newAssembly(spec) {
  return {
    spec,
    placements: new Map(),   // uid -> placement
    order: [],               // 放置顺序（用于回退）
    connections: [],         // {a:{uid,ifaceId}, b:{uid,ifaceId}}
    openEnds: [],            // 世界接口 + uid，按 key 排序
    remaining: { ...(spec.modules ?? {}) },
    log: [],
  };
}

export function openEndsSorted(state) {
  return [...state.openEnds].sort((a, b) => (a.key < b.key ? -1 : 1));
}

function consumedSet(state) {
  const used = new Set();
  for (const c of state.connections) {
    used.add(`${c.a.uid}:${c.a.ifaceId}`);
    used.add(`${c.b.uid}:${c.b.ifaceId}`);
  }
  return used;
}

export function rebuildOpenEnds(state) {
  const used = consumedSet(state);
  const ends = [];
  for (const p of state.placements.values()) {
    for (const w of p.ifaces) {
      if (!used.has(`${p.uid}:${w.ifaceId}`)) {
        ends.push({ ...w, uid: p.uid, key: endKey(w) });
      }
    }
  }
  state.openEnds = ends;
  return ends;
}

export function addPlacement(state, placement, links) {
  state.placements.set(placement.uid, placement);
  state.order.push(placement.uid);
  for (const l of links) {
    state.connections.push({
      a: { uid: placement.uid, ifaceId: l.candIfaceId },
      b: { uid: l.otherUid, ifaceId: l.otherIfaceId },
    });
  }
  if (state.remaining[placement.type] !== undefined) {
    state.remaining[placement.type] -= 1;
    if (state.remaining[placement.type] <= 0) delete state.remaining[placement.type];
  }
  rebuildOpenEnds(state);
}

export function removePlacement(state, uid) {
  const p = state.placements.get(uid);
  if (!p) return null;
  state.placements.delete(uid);
  state.order = state.order.filter((u) => u !== uid);
  state.connections = state.connections.filter((c) => c.a.uid !== uid && c.b.uid !== uid);
  if (state.spec.modules && state.spec.modules[p.type] !== undefined) {
    state.remaining[p.type] = (state.remaining[p.type] ?? 0) + 1;
  }
  rebuildOpenEnds(state);
  return p;
}

// 模块连接图（用于环路判定与乘客路线）
export function moduleGraph(state, extraLinks = [], extraUid = null) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  };
  for (const c of state.connections) add(c.a.uid, c.b.uid);
  for (const l of extraLinks) add(extraUid, l.otherUid);
  return adj;
}

export function reachableFrom(state, adj, startUid) {
  const seen = new Set([startUid]);
  const q = [startUid];
  while (q.length) {
    const u = q.pop();
    for (const v of adj.get(u) ?? []) {
      if (!seen.has(v)) { seen.add(v); q.push(v); }
    }
  }
  return seen;
}

// 门洞向外探测盒：检测门是否被邻模块墙体堵住 / 与邻接口对齐
function doorProbe(w) {
  const D = 0.6;
  const hx = w.dir.x === 0 ? w.w / 2 - 0.01 : D;
  const hz = w.dir.z === 0 ? w.w / 2 - 0.01 : D;
  const cx = w.center.x + w.dir.x * (WALL_T + D / 2);
  const cz = w.center.z + w.dir.z * (WALL_T + D / 2);
  return {
    min: { x: cx - (w.dir.x !== 0 ? D / 2 : hx), y: 0.1, z: cz - (w.dir.z !== 0 ? D / 2 : hz) },
    max: { x: cx + (w.dir.x !== 0 ? D / 2 : hx), y: w.h, z: cz + (w.dir.z !== 0 ? D / 2 : hz) },
  };
}

function ifaceAt(p, center) {
  return p.ifaces.find((w) => Math.abs(w.center.x - center.x) < EPS
    && Math.abs(w.center.z - center.z) < EPS);
}

// 核心放置检查。attachTo: 求解器主对接的开放端（可选）。
// 返回 { ok, reasons[], links[] }；links 含主连接与附带环路连接。
export function checkPlacement(state, def, rot, pos, attachTo = null) {
  const reasons = [];
  const links = [];
  const cand = makePlacement(def.type, rot, pos);
  const spec = state.spec;

  if (spec.bounds && !boxInsideBounds(cand.aabb, spec.bounds)) {
    reasons.push({ code: 'bounds', text: `超出站体边界 ${fmtVec(cand.aabb.min)}~${fmtVec(cand.aabb.max)}` });
  }
  for (const p of state.placements.values()) {
    if (overlaps(cand.aabb, p.aabb)) {
      reasons.push({ code: 'overlap', withUid: p.uid, withType: p.type, text: `与 ${p.type}(${p.uid}) 体积重叠` });
    }
  }

  // 接口审计：每个门洞外侧若贴有邻模块，必须存在类型匹配、朝向相对、门洞重合的接口
  for (const w of cand.ifaces) {
    const probe = doorProbe(w);
    for (const p of state.placements.values()) {
      if (!overlaps(probe, p.aabb)) continue;
      const their = ifaceAt(p, w.center);
      if (!their) {
        reasons.push({
          code: 'door-blocked', withUid: p.uid, withType: p.type,
          text: `门洞 ${w.type}@${fmtVec(w.center)} 被 ${p.type}(${p.uid}) 的墙体堵住`,
        });
        continue;
      }
      const dirOk = their.dir.x === -w.dir.x && their.dir.z === -w.dir.z;
      if (!dirOk || their.type !== w.type) {
        reasons.push({
          code: 'iface-mismatch', withUid: p.uid, withType: p.type,
          text: `接口不匹配：${w.type} 对 ${their.type} @${fmtVec(w.center)}（类型/朝向不一致，不得以遮挡掩盖）`,
        });
        continue;
      }
      const used = consumedSet(state).has(`${p.uid}:${their.ifaceId}`);
      if (used) {
        reasons.push({
          code: 'iface-busy', withUid: p.uid, withType: p.type,
          text: `接口已被占用：${p.type}(${p.uid}) 的 ${their.ifaceId} @${fmtVec(w.center)}`,
        });
        continue;
      }
      const isPrimary = attachTo && attachTo.uid === p.uid && attachTo.ifaceId === their.ifaceId;
      links.push({ candIfaceId: w.ifaceId, otherUid: p.uid, otherIfaceId: their.ifaceId, kind: isPrimary ? 'primary' : 'incidental' });
    }
  }
  if (attachTo && !links.some((l) => l.kind === 'primary')) {
    reasons.push({ code: 'no-primary', text: '主对接接口未对齐' });
  }

  // 区域间距
  for (const rule of spec.spacing ?? []) {
    const myTags = def.tags;
    if (!myTags.includes(rule.a) && !myTags.includes(rule.b)) continue;
    const otherTag = myTags.includes(rule.a) ? rule.b : rule.a;
    for (const p of state.placements.values()) {
      if (!p.tags.includes(otherTag)) continue;
      const d = aabbDistance(cand.aabb, p.aabb);
      if (d < rule.min - EPS) {
        reasons.push({
          code: 'spacing', withUid: p.uid, withType: p.type,
          text: `区域间距不足：${rule.a}↔${rule.b} 实测 ${d.toFixed(1)}m < 要求 ${rule.min}m（对方 ${p.type}@${p.uid}）`,
        });
      }
    }
  }
  return { ok: reasons.length === 0, reasons, links, cand };
}

// 端盖数之外的开放端账面：ends + Σ(d-1) 必须能归零（允许偶数消耗于环路）
// 另有模块未放置时开放端不得归零——新模块只能经开放端接入，归零即死局
export function endsFeasible(state, extraEnds, remaining) {
  if (state.spec.allowOpenEnds) return true;
  if (extraEnds === 0 && Object.keys(remaining).length > 0) return false;
  let potential = extraEnds;
  let hasOdd = false;
  for (const [t, n] of Object.entries(remaining)) {
    const d = MODULES[t].doorCount;
    potential += n * (d - 1);
    if (d % 2 === 1 && n > 0) hasOdd = true;
  }
  if (potential < 0) return false;
  if (potential % 2 !== 0 && !hasOdd) return false;
  return true;
}

// 可行连接：对某个开放端，枚举所有能合法对接的模块/朝向/位置
export function feasibleConnections(state, end) {
  const out = [];
  for (const def of Object.values(MODULES)) {
    for (const iface of def.interfaces) {
      if (iface.type !== end.type) continue;
      for (let rot = 0; rot < 4; rot++) {
        const probe = makePlacement(def.type, rot, { x: 0, z: 0 });
        const w = probe.ifaces.find((x) => x.ifaceId === iface.id);
        if (w.dir.x !== -end.dir.x || w.dir.z !== -end.dir.z) continue;
        const pos = { x: end.center.x - w.center.x, z: end.center.z - w.center.z };
        const chk = checkPlacement(state, def, rot, pos, end);
        if (chk.ok) {
          out.push({
            type: def.type, label: def.label, rot, pos, ifaceId: iface.id,
            loops: chk.links.filter((l) => l.kind === 'incidental').length,
          });
        }
      }
    }
  }
  return out;
}
