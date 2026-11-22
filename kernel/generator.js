// 生成器：预设规格 -> 求解 -> 全场景验收 -> 生成清单（或结构化失败）
import { solve } from './solver.js';
import { validateScene } from './validate.js';
import { recordFeedback, getFeedback } from './feedback.js';

export const PRESETS = {
  small: {
    label: '小型（教学）',
    spec: {
      entrance: 'airlock',
      modules: { 'corr-straight': 2, 'corr-corner': 1, 'corr-t': 1, 'bay-med': 1, cap: 1 },
      targets: ['medbay'],
      spacing: [],
      bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 8, z: 20 } },
      budget: 20000,
    },
  },
  loop: {
    label: '闭环站台',
    spec: {
      entrance: 'airlock',
      modules: { 'corr-x': 1, 'corr-t': 1, 'corr-corner': 2, 'bay-med': 1, 'bay-hydro': 1 },
      targets: ['medbay', 'hydro'],
      spacing: [],
      bounds: { min: { x: -24, z: -24 }, max: { x: 24, y: 8, z: 24 } },
      budget: 80000,
    },
  },
  medium: {
    label: '中型（间距约束）',
    spec: {
      entrance: 'airlock',
      modules: {
        'corr-straight': 3, 'corr-corner': 2, 'corr-t': 2, 'corr-x': 1,
        'bay-med': 1, 'bay-reactor': 1, 'bay-hydro': 1, cap: 2,
      },
      targets: ['medbay', 'reactor', 'hydro'],
      spacing: [
        { a: 'reactor', b: 'medbay', min: 8 },
      ],
      bounds: { min: { x: -30, z: -30 }, max: { x: 30, y: 8, z: 30 } },
      budget: 200000,
    },
  },
  hangar: {
    label: '机库（C4 货运接口）',
    spec: {
      entrance: 'airlock',
      modules: {
        adapter: 1, 'corr-wide': 2, hangar: 1,
        'corr-straight': 2, 'corr-t': 2, 'bay-med': 1, cap: 1,
      },
      targets: ['hangar', 'medbay'],
      spacing: [],
      bounds: { min: { x: -40, z: -40 }, max: { x: 40, y: 8, z: 40 } },
      budget: 200000,
    },
  },
  large: {
    label: '大型（闭环+间距）',
    spec: {
      entrance: 'airlock',
      modules: {
        'corr-straight': 4, 'corr-corner': 2, 'corr-t': 2, 'corr-x': 1, connector: 2,
        'bay-med': 1, 'bay-reactor': 1, 'bay-hydro': 1, cap: 2,
      },
      targets: ['medbay', 'reactor', 'hydro'],
      spacing: [
        { a: 'reactor', b: 'medbay', min: 12 },
        { a: 'reactor', b: 'hydro', min: 8 },
      ],
      bounds: { min: { x: -30, z: -30 }, max: { x: 30, y: 8, z: 30 } },
      budget: 120000,
    },
  },
  impossible: {
    label: '不可满足（失败演示）',
    spec: {
      entrance: 'airlock',
      modules: { 'corr-straight': 2, 'corr-corner': 1, 'corr-t': 1, 'bay-med': 1, 'bay-reactor': 1 },
      targets: ['medbay', 'reactor'],
      spacing: [{ a: 'reactor', b: 'medbay', min: 50 }],
      bounds: { min: { x: -40, z: -40 }, max: { x: 40, y: 8, z: 40 } },
      budget: 20000,
    },
  },
};

export function makeSpec(presetName, seed, overrides = {}) {
  const p = PRESETS[presetName];
  if (!p) throw new Error(`未知预设 ${presetName}`);
  const spec = JSON.parse(JSON.stringify(p.spec));
  spec.seed = seed;
  return { ...spec, ...overrides };
}

export function generate(spec) {
  const r = solve(spec);
  if (!r.ok) {
    recordFeedback({ source: 'generator', kind: 'solve-failure', seed: spec.seed, reason: r.reason, conflict: r.conflict });
    return { ok: false, reason: r.reason, conflict: r.conflict, log: r.log, stats: r.stats, feedback: getFeedback() };
  }
  const acceptance = validateScene(r.state, spec);
  if (!acceptance.ok) {
    // 求解结果未通过验收：如实上报，不修补不遮挡
    recordFeedback({ source: 'generator', kind: 'acceptance-failed', seed: spec.seed, errors: acceptance.errors });
    return { ok: false, reason: 'acceptance-failed', acceptance, log: r.log, stats: r.stats, feedback: getFeedback() };
  }
  const manifest = {
    format: 'orbital-station-manifest/1',
    seed: spec.seed,
    spec,
    placements: r.state.order.map((uid) => {
      const p = r.state.placements.get(uid);
      return { uid: p.uid, type: p.type, rot: p.rot, pos: p.pos };
    }),
    connections: r.state.connections,
    openEnds: acceptance.openEnds.map((e) => ({ uid: e.uid, ifaceId: e.ifaceId, type: e.type, center: e.center, dir: e.dir })),
    acceptance: {
      ok: acceptance.ok,
      errors: acceptance.errors,
      warnings: acceptance.warnings,
      nav: acceptance.nav.paths.map((p) => ({ to: p.to, length: p.length })),
      stats: acceptance.stats,
    },
    stats: { nodes: r.stats.nodes, backtracks: r.stats.backtracks, redirects: r.stats.redirects, loops: r.stats.loops },
    feedback: getFeedback(),
  };
  return { ok: true, state: r.state, manifest, log: r.log, acceptance };
}
