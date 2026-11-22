// 把内核装配状态转成视窗图元：地板=可通行表面，墙体/设备=碰撞体，门框=开放端
import { MODULES } from '../kernel/modules.js';
import { buildWorld } from '../kernel/validate.js';

export const TAG_COLORS = {
  entrance: '#26c6da', corridor: '#78909c', connector: '#66bb6a',
  medbay: '#e57373', reactor: '#ffb74d', hydro: '#9ccc65',
  hangar: '#ba68c8', cap: '#8d6e63',
  deck: '#4db6ac', cargo: '#9575cd', service: '#90a4ae',
  'low-clearance': '#a1887f', corner: '#78909c',
};

export function colorFor(p) {
  for (const t of p.tags) if (TAG_COLORS[t]) return TAG_COLORS[t];
  return '#78909c';
}

export function showState(vp, state, opts = {}) {
  vp.boxes = [];
  vp.frames = [];
  vp.polylines = [];
  vp.labels = [];
  const world = buildWorld(state);

  for (const f of world.floors) {
    const p = state.placements.get(f.uid);
    vp.boxes.push({ ...f, color: colorFor(p), alpha: 0.9, uid: f.uid, edge: opts.selected === f.uid ? '#ffeb3b' : null });
  }
  for (const w of world.walls) {
    vp.boxes.push({ ...w, color: '#455a64', alpha: 0.96, uid: w.uid, skipTop: true, edge: opts.selected === w.uid ? '#ffeb3b' : null });
  }
  for (const o of world.obstacles) {
    vp.boxes.push({ ...o, color: '#263238', alpha: 1, uid: o.uid, skipTop: false });
  }
  // 夹层板（双层资产的上层平台）
  for (const s of world.slabs ?? []) {
    vp.boxes.push({ ...s, color: '#546e7a', alpha: 0.85, uid: s.uid, skipTop: false });
  }
  // 开放端门框：这是可行连接的锚点，醒目提示而非遮挡
  for (const e of state.openEnds) {
    vp.frames.push({
      center: e.center, dir: e.dir, w: e.w, h: e.h,
      color: opts.selectedEnd && opts.selectedEnd.key === e.key ? '#ffff8d' : '#69f0ae',
    });
  }
  // 乘客路线
  for (const p of opts.navPaths ?? []) {
    vp.polylines.push({ pts: p.pts, color: p.color ?? '#ff5252', width: 3, y: 0.12 });
  }
  // 标注
  for (const pl of state.placements.values()) {
    const def = MODULES[pl.type];
    vp.labels.push({
      p: { x: (pl.aabb.min.x + pl.aabb.max.x) / 2, y: def.size.y + 0.4, z: (pl.aabb.min.z + pl.aabb.max.z) / 2 },
      text: `${def.label} ${pl.uid}`, color: '#b0bec5',
    });
  }
  if (opts.ghost) {
    vp.boxes.push({
      min: opts.ghost.min, max: opts.ghost.max,
      color: opts.ghost.ok ? '#00e676' : '#ff1744',
      alpha: 0.35, edge: opts.ghost.ok ? '#00e676' : '#ff1744',
    });
  }
  if (opts.bounds) {
    const b = opts.bounds;
    vp.grid = { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z, step: 4 };
  }
  vp.render();
}
