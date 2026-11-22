// 逆向策略：从成品站台清单逆推缺件 / 在局部装配上补缺完成。
// 与正向“按连接口约束生成”共用同一套内核检查，保证比较口径一致。
import { MODULES } from './modules.js';
import { makeRng } from './rng.js';
import {
  newAssembly, checkPlacement, addPlacement, removePlacement,
  openEndsSorted, feasibleConnections, resetUid,
} from './assembly.js';

// 从成品清单重建装配，并按库存核销：哪些部件缺失、哪些富余
export function inferMissingPieces(manifest, inventory) {
  resetUid(1);
  const spec = { ...(manifest.spec ?? {}), modules: {} };
  const state = newAssembly(spec);
  const inv = { ...(inventory ?? {}) };
  const missing = {};
  const unplaceable = [];
  const rebuiltUids = [];

  for (const pl of manifest.placements ?? []) {
    const def = MODULES[pl.type];
    if (!def) {
      unplaceable.push({ uid: pl.uid, type: pl.type, reasons: [`未注册的模块类型 ${pl.type}`] });
      rebuiltUids.push(null);
      continue;
    }
    const chk = checkPlacement(state, def, pl.rot, pl.pos, null);
    if (!chk.ok) {
      unplaceable.push({ uid: pl.uid, type: pl.type, reasons: chk.reasons.map((r) => r.text) });
      rebuiltUids.push(null);
      continue;
    }
    addPlacement(state, chk.cand, chk.links);
    rebuiltUids.push(chk.cand.uid);
    if ((inv[pl.type] ?? 0) > 0) inv[pl.type] -= 1;
    else missing[pl.type] = (missing[pl.type] ?? 0) + 1;
  }

  // 连接一致性：清单连接（按放置序号归一）与重建连接逐一比对
  const idxOf = new Map((manifest.placements ?? []).map((p, i) => [p.uid, i]));
  const norm = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const manifestConns = new Set((manifest.connections ?? [])
    .filter((c) => idxOf.has(c.a?.uid) && idxOf.has(c.b?.uid))
    .map((c) => norm(idxOf.get(c.a.uid), idxOf.get(c.b.uid))));
  const rebuiltIdx = new Map();
  rebuiltUids.forEach((uid, i) => { if (uid) rebuiltIdx.set(uid, i); });
  const rebuiltConns = new Set(state.connections
    .filter((c) => rebuiltIdx.has(c.a.uid) && rebuiltIdx.has(c.b.uid))
    .map((c) => norm(rebuiltIdx.get(c.a.uid), rebuiltIdx.get(c.b.uid))));
  const connectionsMatch = manifestConns.size === rebuiltConns.size
    && [...manifestConns].every((k) => rebuiltConns.has(k));

  const surplus = Object.fromEntries(Object.entries(inv).filter(([, n]) => n > 0));
  return {
    ok: unplaceable.length === 0 && connectionsMatch,
    missing, surplus, unplaceable,
    connections: { manifest: manifestConns.size, rebuilt: rebuiltConns.size, match: connectionsMatch },
    state,
  };
}

// 由放置列表重建局部装配（逆推补缺的起点）
export function rebuildPartial(placements, spec = {}) {
  resetUid(1);
  const state = newAssembly({ ...spec, modules: {} });
  for (const pl of placements) {
    const def = MODULES[pl.type];
    const chk = checkPlacement(state, def, pl.rot, pl.pos, null);
    if (!chk.ok) return { ok: false, state, failedAt: pl, reasons: chk.reasons.map((r) => r.text) };
    addPlacement(state, chk.cand, chk.links);
  }
  return { ok: true, state };
}

// 补缺完成：在局部装配上，用给定库存把开放端全部封闭（带回退，节点预算限制）
export function planCompletion(state, inventory, opts = {}) {
  const rng = makeRng(opts.seed ?? 'reverse-complete');
  const budget = opts.budget ?? 20000;
  const remaining = { ...inventory };
  const stats = { steps: 0, backtracks: 0 };
  const placed = [];

  function dfs() {
    stats.steps += 1;
    if (stats.steps > budget) return 'budget';
    const done = Object.values(remaining).every((n) => n <= 0);
    if (done) {
      if (state.spec.allowOpenEnds || state.openEnds.length === 0) return 'ok';
      return 'fail';
    }
    const ends = openEndsSorted(state);
    if (ends.length === 0) return 'fail';
    const end = ends[0];
    const feas = feasibleConnections(state, end)
      .filter((f) => (remaining[f.type] ?? 0) > 0);
    for (const f of rng.shuffle(feas)) {
      const def = MODULES[f.type];
      const chk = checkPlacement(state, def, f.rot, f.pos, end);
      if (!chk.ok) continue;
      addPlacement(state, chk.cand, chk.links);
      remaining[f.type] -= 1;
      placed.push(chk.cand.uid);
      const r = dfs();
      if (r === 'ok' || r === 'budget') return r;
      removePlacement(state, chk.cand.uid);
      remaining[f.type] += 1;
      placed.pop();
      stats.backtracks += 1;
    }
    return 'fail';
  }

  const result = dfs();
  return { ok: result === 'ok', reason: result === 'ok' ? null : result, stats, state, placed };
}
