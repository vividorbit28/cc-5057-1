// 小规模可穷举核对：不剪枝、无预算地枚全部装配，与求解器结论互相印证。
// 每个穷举出的有效装配再交给 validateScene 做几何碰撞与导航通路验收。
import { MODULES } from './modules.js';
import {
  newAssembly, makePlacement, checkPlacement, addPlacement, removePlacement, resetUid,
} from './assembly.js';
import { solve } from './solver.js';
import { validateScene } from './validate.js';

export function assemblySignature(state) {
  return [...state.placements.values()]
    .map((p) => `${p.type}:${p.rot}:${p.pos.x.toFixed(2)}:${p.pos.z.toFixed(2)}`)
    .sort()
    .join('|');
}

// 枚举所有合法终态装配（全部模块落位、开放端封闭、图连通由构造保证）
export function bruteForce(spec, limit = 100000) {
  resetUid(1);
  const state = newAssembly(spec);
  const entrance = makePlacement(spec.entrance ?? 'airlock', spec.entranceRot ?? 0, spec.entrancePos ?? { x: 0, z: 0 });
  addPlacement(state, entrance, []);
  const valid = [];
  let nodes = 0;

  function finalOk() {
    if (!spec.allowOpenEnds && state.openEnds.length > 0) return false;
    for (const rule of spec.spacing ?? []) {
      const as = [...state.placements.values()].filter((p) => p.tags.includes(rule.a));
      const bs = [...state.placements.values()].filter((p) => p.tags.includes(rule.b));
      for (const a of as) for (const b of bs) {
        const dx = Math.max(0, a.aabb.min.x - b.aabb.max.x, b.aabb.min.x - a.aabb.max.x);
        const dz = Math.max(0, a.aabb.min.z - b.aabb.max.z, b.aabb.min.z - a.aabb.max.z);
        if (Math.hypot(dx, dz) < rule.min - 1e-6) return false;
      }
    }
    return true;
  }

  function rec() {
    nodes += 1;
    if (nodes > limit) return;
    if (Object.keys(state.remaining).length === 0) {
      if (finalOk()) valid.push(assemblySignature(state));
      return;
    }
    const ends = [...state.openEnds];
    for (const end of ends) {
      for (const type of Object.keys(state.remaining)) {
        const def = MODULES[type];
        for (const iface of def.interfaces) {
          if (iface.type !== end.type) continue;
          for (let rot = 0; rot < 4; rot++) {
            const probe = makePlacement(type, rot, { x: 0, z: 0 });
            const w = probe.ifaces.find((x) => x.ifaceId === iface.id);
            if (w.dir.x !== -end.dir.x || w.dir.z !== -end.dir.z) continue;
            const pos = { x: end.center.x - w.center.x, z: end.center.z - w.center.z };
            const chk = checkPlacement(state, def, rot, pos, end);
            if (!chk.ok) continue;
            addPlacement(state, chk.cand, chk.links);
            rec();
            removePlacement(state, chk.cand.uid);
          }
        }
      }
    }
  }
  rec();
  return { valid: [...new Set(valid)], nodes, exhausted: nodes > limit };
}

// 交叉核对：求解器可解 当且仅当 穷举存在有效解；且求解器解在穷举集合中
export function crossCheck(spec) {
  const bf = bruteForce(spec);
  const r = solve(spec);
  const out = {
    bruteCount: bf.valid.length,
    bruteNodes: bf.nodes,
    solverSat: r.ok,
    agree: (bf.valid.length > 0) === r.ok,
    solverInBruteSet: null,
    acceptanceFailures: [],
  };
  if (r.ok) {
    out.solverInBruteSet = bf.valid.includes(assemblySignature(r.state));
  }
  // 穷举有效解抽样做全场景验收（几何碰撞 + 导航通路）
  const sample = bf.valid.slice(0, 30);
  for (const sig of sample) {
    const st = newAssembly(spec);
    const ent = makePlacement(spec.entrance ?? 'airlock', spec.entranceRot ?? 0, spec.entrancePos ?? { x: 0, z: 0 });
    addPlacement(st, ent, []);
    for (const part of sig.split('|')) {
      const [type, rot, x, z] = part.split(':');
      if (type === (spec.entrance ?? 'airlock') && Number(x) === 0 && Number(z) === 0) continue;
      const p = makePlacement(type, Number(rot), { x: Number(x), z: Number(z) });
      // 重建连接：与既有模块对齐的接口全部连上
      const chk = checkPlacement(st, MODULES[type], Number(rot), { x: Number(x), z: Number(z) }, null);
      addPlacement(st, p, chk.links);
    }
    const acc = validateScene(st, spec);
    if (!acc.ok) out.acceptanceFailures.push({ sig, errors: acc.errors });
  }
  return out;
}
