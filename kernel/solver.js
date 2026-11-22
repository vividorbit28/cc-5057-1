// 求解器：种子可复现的回溯搜索。
// 局部改向（同模块换朝向/接口，牺牲该朝向的出口）优先于全局回退（弹出先前置件，牺牲其出口）。
// 闭环最后一接口落位时，以乘客可达路线（装配几何上的导航连通）决定能否提交。
// 失败时返回冲突模块与条件，搜索有节点上限，不无限重试。
import { MODULES } from './modules.js';
import { makeRng } from './rng.js';
import {
  newAssembly, makePlacement, checkPlacement, addPlacement, removePlacement,
  openEndsSorted, moduleGraph, reachableFrom, endsFeasible, rebuildOpenEnds, resetUid,
} from './assembly.js';
import { validateNav, sealedUnreachableTargets } from './validate.js';
import { fmtVec } from './geom.js';

export function solve(spec) {
  const t0 = Date.now();
  resetUid(1);
  const rng = makeRng(spec.seed);
  const state = newAssembly(spec);
  const log = [];
  const stats = { nodes: 0, backtracks: 0, redirects: 0, loops: 0 };
  const budget = spec.budget ?? 20000;

  // 部件身份核验：规格引用的模块类型必须已注册（套件未加载时给出结构化失败，不抛异常）
  const unknown = [...new Set([spec.entrance ?? 'airlock', ...Object.keys(state.remaining)])]
    .filter((t) => !MODULES[t]);
  if (unknown.length > 0) {
    const text = `未注册的模块类型：${unknown.join(', ')}（对应套件未加载）`;
    log.push({ kind: 'dead-end', note: text });
    return {
      ok: false, reason: 'unknown-module',
      conflict: { atDepth: 0, atInterface: null, remaining: { ...state.remaining }, conflictingModules: [], conditions: [text], tried: [] },
      log, stats: { ...stats, ms: Date.now() - t0 }, seed: spec.seed,
    };
  }

  // 入口固定落位（确定性锚点）
  const entranceType = spec.entrance ?? 'airlock';
  const entrance = makePlacement(entranceType, spec.entranceRot ?? 0, spec.entrancePos ?? { x: 0, z: 0 });
  addPlacement(state, entrance, []);
  log.push({ kind: 'place', uid: entrance.uid, type: entranceType, rot: entrance.rot, pos: entrance.pos, anchor: true, note: '入口锚定' });

  let deepest = { depth: -1, end: null, tried: [] };

  const entranceUid = entrance.uid;

  function placedTargets() {
    const tags = spec.targets ?? [];
    return [...state.placements.values()].filter((p) => p.tags.some((t) => tags.includes(t)));
  }

  function lowClearancePresent() {
    for (const p of state.placements.values()) {
      if (p.tags.includes('low-clearance')) return true;
    }
    return false;
  }

  // 乘客可达路线：在当前装配几何上做导航网格连通检查
  function passengerRoutesOk() {
    const nav = validateNav(state, spec);
    return nav.ok;
  }

  function* candidates(end) {
    const types = rng.shuffle(Object.keys(state.remaining));
    for (const type of types) {
      const def = MODULES[type];
      const ifaces = def.interfaces.filter((i) => i.type === end.type);
      for (const iface of ifaces) {
        for (const rot of rng.shuffle([0, 1, 2, 3])) {
          const w = makePlacement(type, rot, { x: 0, z: 0 }).ifaces.find((x) => x.ifaceId === iface.id);
          // 旋转后接口朝向必须与开放端相对
          if (w.dir.x !== -end.dir.x || w.dir.z !== -end.dir.z) continue;
          const pos = { x: end.center.x - w.center.x, z: end.center.z - w.center.z };
          yield { def, rot, pos, ifaceId: iface.id };
        }
      }
    }
  }

  function dfs(depth) {
    stats.nodes += 1;
    if (stats.nodes > budget) return 'budget';
    if (Object.keys(state.remaining).length === 0) {
      const fin = finalCheck();
      if (fin.ok) {
        log.push({ kind: 'success', note: '全部模块落位，全局约束与乘客路线验收通过' });
        return 'ok';
      }
      log.push({ kind: 'final-reject', reasons: fin.reasons });
      remember(deepest, depth, null, [{ reasons: fin.reasons.map((t) => ({ code: 'final', text: t })) }]);
      return 'fail';
    }

    const ends = openEndsSorted(state);
    if (ends.length === 0) {
      const note = `开放端已封闭但仍有模块未放置：${Object.keys(state.remaining).join(', ')}`;
      log.push({ kind: 'dead-end', note, remaining: { ...state.remaining } });
      remember(deepest, depth, null, [{ desc: '(封闭)', reasons: [{ code: 'sealed', text: note }] }]);
      return 'fail';
    }
    const end = ends[rng.int(ends.length)];
    let anyTried = false;
    let lastType = null;
    let triedHere = [];

    for (const cand of candidates(end)) {
      const chk = checkPlacement(state, cand.def, cand.rot, cand.pos, end);
      const desc = `${cand.def.type}#${cand.ifaceId} rot${cand.rot} @${fmtVec({ x: cand.pos.x, y: 0, z: cand.pos.z })}`;
      if (!chk.ok) {
        triedHere.push({ desc, type: cand.def.type, rot: cand.rot, pos: cand.pos, reasons: chk.reasons });
        if (lastType === cand.def.type) {
          // 局部改向：同模块换朝向/接口，牺牲的是上一朝向能保留的出口
          stats.redirects += 1;
          log.push({
            kind: 'local-redirect', type: cand.def.type, rot: cand.rot, pos: cand.pos,
            note: `局部改向 ${desc}：${chk.reasons[0].text}`,
            sacrificedExits: exitsOf(chk.cand),
          });
        } else {
          log.push({ kind: 'try-fail', type: cand.def.type, rot: cand.rot, pos: cand.pos, note: `${desc} 被拒：${chk.reasons[0].text}`, reasons: chk.reasons });
        }
        lastType = cand.def.type;
        continue;
      }
      anyTried = true;

      // 环路判定：附带连接是否接到已连通分量
      const adj = moduleGraph(state);
      const comp = reachableFrom(state, adj, end.uid);
      const loops = chk.links.filter((l) => l.kind === 'incidental' && comp.has(l.otherUid));
      const placement = chk.cand;

      // 先试装，再验证乘客路线与出口账面，决定闭环能否提交
      addPlacement(state, placement, chk.links);
      const endsAfter = state.openEnds.length;
      let commit = endsFeasible(state, endsAfter, state.remaining);
      let routeNote = '';
      if (loops.length > 0) {
        stats.loops += 1;
        const routesOk = passengerRoutesOk();
        routeNote = routesOk ? '乘客可达路线保持' : '乘客可达路线被切断';
        commit = commit && routesOk;
      }
      // 封死剪枝：装配中有低通行高度件且目标舱已放置时，若入口/目标区域已无开放端，
      // 连通性不可能再恢复——立即回溯，不再深入必死子树
      let sealedNote = '';
      if (commit && lowClearancePresent() && placedTargets().length > 0) {
        const sealed = sealedUnreachableTargets(state, spec);
        if (sealed.length > 0) {
          commit = false;
          sealedNote = `目标舱被封死（区域无开放端，连通不可恢复）：${sealed.join('、')}`;
        }
      }
      if (!commit) {
        removePlacement(state, placement.uid);
        if (sealedNote) {
          stats.sealed = (stats.sealed ?? 0) + 1;
          log.push({
            kind: 'nav-sealed', uid: placement.uid, type: placement.type, rot: placement.rot, pos: placement.pos,
            note: `${placement.type}(${placement.uid}) 落位后${sealedNote}，回溯`,
          });
        } else if (loops.length > 0) {
          log.push({
            kind: 'loop-reject',
            uid: placement.uid, type: placement.type, rot: placement.rot, pos: placement.pos,
            loops: loops.map((l) => l.otherUid),
            sacrificedExits: loops.map((l) => `${l.otherUid}:${l.otherIfaceId}`),
            note: `闭环最后接口落位：${routeNote}，放弃提交（牺牲出口 ${loops.length} 个）`,
          });
        } else {
          log.push({ kind: 'try-fail', type: placement.type, rot: placement.rot, pos: placement.pos, note: `${placement.type} 出口账面不可行（剩余开放端无法归零）` });
        }
        triedHere.push({ desc, type: placement.type, rot: placement.rot, pos: placement.pos, reasons: [{ code: sealedNote ? 'nav-sealed' : 'ends', text: sealedNote || '出口账面不可行或乘客路线被切断' }] });
        lastType = placement.type;
        continue;
      }

      if (loops.length > 0) {
        log.push({
          kind: 'loop-commit',
          uid: placement.uid, type: placement.type, rot: placement.rot, pos: placement.pos,
          loops: loops.map((l) => l.otherUid),
          sacrificedExits: loops.map((l) => `${l.otherUid}:${l.otherIfaceId}`),
          note: `闭环最后接口落位：${routeNote}，提交（封闭出口 ${loops.length} 个）`,
        });
      }
      log.push({
        kind: 'place', uid: placement.uid, type: placement.type, rot: placement.rot, pos: placement.pos,
        links: chk.links.map((l) => ({ iface: l.candIfaceId, to: `${l.otherUid}:${l.otherIfaceId}`, kind: l.kind })),
        openEnds: endsAfter,
      });
      const r = dfs(depth + 1);
      if (r === 'ok' || r === 'budget') return r;
      // 全局回退：弹出该模块，牺牲它带来的全部出口
      const exits = state.openEnds.filter((e) => e.uid === placement.uid).map((e) => `${placement.type}:${e.ifaceId}@${fmtVec(e.center)}`);
      removePlacement(state, placement.uid);
      stats.backtracks += 1;
      log.push({
        kind: 'global-backtrack', uid: placement.uid, type: placement.type,
        sacrificedExits: exits,
        note: `全局回退 ${placement.type}(${placement.uid})，牺牲出口 ${exits.length} 个`,
      });
      lastType = placement.type;
    }

    remember(deepest, depth, end, triedHere);
    if (!anyTried && triedHere.length === 0) {
      const endTypes = new Set(ends.map((e) => e.type));
      const unmatched = Object.keys(state.remaining)
        .filter((t) => MODULES[t].interfaces.every((i) => !endTypes.has(i.type)));
      let note = `没有剩余模块能对接 ${end.type} 开放端 @${fmtVec(end.center)}`;
      if (unmatched.length > 0) {
        note += `；剩余模块 ${unmatched.join(', ')} 的接口类型（${[...new Set(unmatched.flatMap((t) => MODULES[t].interfaces.map((i) => i.type)))].join('/')}）与当前开放端（${[...endTypes].join('/')}）互不匹配`;
      }
      log.push({ kind: 'dead-end', note, remaining: { ...state.remaining } });
      remember(deepest, depth, end, [{ desc: '(无候选)', reasons: [{ code: 'no-candidate', text: note }] }]);
    }
    return 'fail';
  }

  function finalCheck() {
    const reasons = [];
    if (!spec.allowOpenEnds && state.openEnds.length > 0) {
      reasons.push(`存在未封闭开放端 ${state.openEnds.length} 个（需端盖或连接）`);
    }
    const adj = moduleGraph(state);
    const reach = reachableFrom(state, adj, entranceUid);
    for (const p of placedTargets()) {
      if (!reach.has(p.uid)) reasons.push(`目标舱不可达：${p.type}(${p.uid}) 图连通断裂`);
    }
    const nav = validateNav(state, spec);
    for (const u of nav.unreachable) reasons.push(`乘客路线不可达：${u}`);
    for (const rule of spec.spacing ?? []) {
      const as = [...state.placements.values()].filter((p) => p.tags.includes(rule.a));
      const bs = [...state.placements.values()].filter((p) => p.tags.includes(rule.b));
      for (const a of as) for (const b of bs) {
        const { aabbDistance } = geomRef;
        const d = aabbDistance(a.aabb, b.aabb);
        if (d < rule.min - 1e-6) reasons.push(`区域间距不足：${rule.a}↔${rule.b} ${d.toFixed(1)}m < ${rule.min}m`);
      }
    }
    return { ok: reasons.length === 0, reasons };
  }

  const result = dfs(0);
  const ms = Date.now() - t0;
  if (result === 'ok') {
    return { ok: true, state, log, stats: { ...stats, ms } };
  }
  const conflict = summarizeConflict(deepest, state);
  return {
    ok: false,
    reason: result === 'budget' ? 'budget-exhausted' : 'unsatisfiable',
    conflict,
    log,
    stats: { ...stats, ms },
    seed: spec.seed,
  };
}

function exitsOf(cand) {
  return cand.ifaces.map((w) => `${cand.type}:${w.ifaceId}@${fmtVec(w.center)}`);
}

function remember(deepest, depth, end, tried) {
  const count = tried.reduce((n, t) => n + (t.reasons?.length ?? 0), 0);
  if (depth > deepest.depth || (depth === deepest.depth && count > (deepest.count ?? 0))) {
    deepest.depth = depth;
    deepest.count = count;
    deepest.end = end ? { type: end.type, center: end.center, dir: end.dir } : null;
    deepest.tried = tried;
  }
}

import * as geomRef from './geom.js';

function summarizeConflict(deepest, state) {
  const conditions = [];
  const modules = new Map();
  for (const t of deepest.tried ?? []) {
    for (const r of t.reasons ?? []) {
      conditions.push(r.text);
      if (r.withUid) modules.set(r.withUid, r.withType);
    }
  }
  return {
    atDepth: deepest.depth,
    atInterface: deepest.end,
    remaining: { ...state.remaining },
    conflictingModules: [...modules.entries()].map(([uid, type]) => ({ uid, type })),
    conditions: [...new Set(conditions)],
    tried: (deepest.tried ?? []).map((t) => ({
      desc: t.desc, reasons: (t.reasons ?? []).map((r) => r.text),
    })),
  };
}

// 供 UI 逐步回放：重放日志到第 k 步，返回当时装配状态
export function replayLog(spec, log, k) {
  resetUid(1);
  const state = newAssembly(spec);
  rebuildOpenEnds(state);
  for (let i = 0; i <= k && i < log.length; i++) {
    const e = log[i];
    if (e.kind === 'place') {
      const p = makePlacement(e.type, e.rot, e.pos);
      p.uid = e.uid;
      const links = (e.links ?? []).map((l) => {
        const [otherUid, otherIfaceId] = l.to.split(':');
        return { candIfaceId: l.iface, otherUid, otherIfaceId };
      });
      addPlacement(state, p, links);
    } else if (e.kind === 'global-backtrack') {
      if (state.placements.has(e.uid)) removePlacement(state, e.uid);
    }
  }
  return state;
}
