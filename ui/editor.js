// 手动拼装模式：拖放模块 -> 内核检查 -> 合法落位或反馈失败。
// 所有判定由轨道站拼装内核完成；失败反馈回内核反馈通道。
import { MODULES } from '../kernel/modules.js';
import {
  newAssembly, makePlacement, addPlacement, removePlacement,
  checkPlacement, feasibleConnections,
} from '../kernel/assembly.js';
import { validateScene, validateNav } from '../kernel/validate.js';
import { recordFeedback } from '../kernel/feedback.js';
import { showState } from './sceneview.js';

export function createEditor({ vp, ui }) {
  const spec = {
    allowOpenEnds: true,
    targets: ['medbay', 'reactor', 'hydro'],
    spacing: [{ a: 'reactor', b: 'medbay', min: 8 }],
    bounds: { min: { x: -30, z: -30 }, max: { x: 30, y: 8, z: 30 } },
    modules: {},
  };
  const state = newAssembly(spec);
  addPlacement(state, makePlacement('airlock', 0, { x: 0, z: 0 }), []);

  const ed = {
    state, spec,
    rot: 0,
    selected: null,
    selectedEnd: null,
    ghost: null,
    navPaths: [],
    acceptance: null,
  };

  function refresh() {
    showState(vp, state, {
      bounds: spec.bounds,
      selected: ed.selected,
      selectedEnd: ed.selectedEnd,
      ghost: ed.ghost,
      navPaths: ed.navPaths,
    });
    ui.renderEnds(state, ed.selectedEnd);
    ui.renderAcceptance(ed.acceptance);
  }

  function tryPlaceAt(type, rot, pos, source) {
    const def = MODULES[type];
    const chk = checkPlacement(state, def, rot, pos, null);
    if (chk.ok) {
      const p = makePlacement(type, rot, pos);
      addPlacement(state, p, chk.links);
      ed.acceptance = null;
      ed.navPaths = [];
      ui.log(`手动放置 ${def.label} @(${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}) rot${rot}，连接 ${chk.links.length} 处`);
      refresh();
      return true;
    }
    recordFeedback({ source: 'ui', kind: 'manual-reject', type, rot, pos, reasons: chk.reasons.map((r) => r.text) });
    ui.log(`内核拒绝 ${def.label}：${chk.reasons[0].text}`);
    ui.renderFeedback();
    return false;
  }

  // 拖放
  vp.canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/module') || dragType;
    if (!type) return;
    const r = vp.canvas.getBoundingClientRect();
    const g = vp.groundPoint(e.clientX - r.left, e.clientY - r.top);
    if (!g) return;
    const pos = { x: Math.round(g.x * 2) / 2, z: Math.round(g.z * 2) / 2 };
    const def = MODULES[type];
    const chk = checkPlacement(state, def, ed.rot, pos, null);
    ed.ghost = { min: chk.cand.aabb.min, max: chk.cand.aabb.max, ok: chk.ok };
    ui.renderGhostReasons(chk.ok ? [] : chk.reasons.map((x) => x.text));
    refresh();
  });
  let dragType = null;
  vp.canvas.addEventListener('dragleave', () => { ed.ghost = null; refresh(); });
  vp.canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/module') || dragType;
    ed.ghost = null;
    if (!type) return;
    const r = vp.canvas.getBoundingClientRect();
    const g = vp.groundPoint(e.clientX - r.left, e.clientY - r.top);
    if (!g) return;
    const pos = { x: Math.round(g.x * 2) / 2, z: Math.round(g.z * 2) / 2 };
    tryPlaceAt(type, ed.rot, pos, 'drop');
  });

  vp.onPick = (uid) => {
    ed.selected = uid;
    if (uid) ui.log(`选中 ${state.placements.get(uid)?.type} (${uid})，按 Delete 移除`);
    refresh();
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' && ed.selected && state.placements.has(ed.selected)) {
      const p = removePlacement(state, ed.selected);
      ui.log(`移除 ${p.type} (${p.uid})`);
      ed.selected = null;
      ed.acceptance = null;
      ed.navPaths = [];
      refresh();
    }
    if (e.key === 'q' || e.key === 'Q') { ed.rot = (ed.rot + 3) & 3; ui.showRot(ed.rot); }
    if (e.key === 'e' || e.key === 'E') { ed.rot = (ed.rot + 1) & 3; ui.showRot(ed.rot); }
  });

  return {
    state, spec, ed,
    setDragType(t) { dragType = t; },
    rotate(d) { ed.rot = (ed.rot + d + 4) & 3; },
    selectEnd(end) {
      ed.selectedEnd = end;
      refresh();
      if (end) ui.renderFeasible(feasibleConnections(state, end), end);
    },
    placeFeasible(f) {
      if (tryPlaceAt(f.type, f.rot, f.pos, 'feasible')) {
        ed.selectedEnd = null;
        refresh();
      }
    },
    removeSelected() {
      if (ed.selected && state.placements.has(ed.selected)) {
        removePlacement(state, ed.selected);
        ed.selected = null;
        refresh();
      }
    },
    accept() {
      ed.acceptance = validateScene(state, spec);
      const nav = validateNav(state, spec);
      ed.navPaths = (nav.paths ?? []).map((p) => ({
        pts: p.cells.map((c) => ({ x: nav.grid.minX + (c.ix + 0.5) * nav.grid.c, z: nav.grid.minZ + (c.iz + 0.5) * nav.grid.c })),
        color: '#ff5252',
      }));
      if (!ed.acceptance.ok) {
        recordFeedback({ source: 'ui', kind: 'manual-acceptance-failed', errors: ed.acceptance.errors });
        ui.renderFeedback();
      }
      refresh();
      return ed.acceptance;
    },
    refresh,
  };
}
