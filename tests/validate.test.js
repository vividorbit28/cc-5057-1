import test from 'node:test';
import assert from 'node:assert/strict';
import { newAssembly, makePlacement, addPlacement } from '../kernel/assembly.js';
import { validateNav, validateScene, buildWorld, buildNavGrid, worldToCell, bfs } from '../kernel/validate.js';

function assemblyWith(placements, spec = {}) {
  const st = newAssembly({ allowOpenEnds: true, targets: [], spacing: [], ...spec });
  for (const [type, rot, x, z] of placements) {
    const p = makePlacement(type, rot, { x, z });
    addPlacement(st, p, []);
  }
  return st;
}

test('导航网格：入口到目标舱有乘客路线，且绕开设备障碍', () => {
  // 入口气闸(0,0) 门在 (2,4) 朝 S；直走廊接在 z=4；反应堆舱接在 z=10
  const st = assemblyWith([
    ['airlock', 0, 0, 0],
    ['corr-straight', 0, 0.5, 4],
    ['bay-reactor', 0, -0.5, 10],
  ], { targets: ['reactor'] });
  const nav = validateNav(st, st.spec);
  assert.equal(nav.ok, true, nav.unreachable.join(';'));
  assert.equal(nav.paths.length, 1);
  // 路径必须绕过反应堆芯（舱内 3..5 x 3..5 局部 -> 世界 (-0.5+3)..(-0.5+5), (10+3)..(10+5)）
  const grid = nav.grid;
  for (const c of nav.paths[0].cells) {
    const x = grid.minX + (c.ix + 0.5) * grid.c;
    const z = grid.minZ + (c.iz + 0.5) * grid.c;
    const inCore = x > 2.5 && x < 4.5 && z > 13 && z < 15;
    assert.ok(!inCore, `路径穿过反应堆芯 (${x},${z})`);
  }
});

test('门洞被封死时导航报不可达', () => {
  // 两个舱贴面但门不对齐：bay-med 的门在 x=3，bay-hydro 用实墙面对它
  const st = assemblyWith([
    ['airlock', 0, 0, 0],
    ['bay-med', 2, 0, 4],      // rot2：门朝 N 贴回 airlock 的实墙
  ], { targets: ['medbay'] });
  const nav = validateNav(st, st.spec);
  assert.equal(nav.ok, false, '门被墙堵住时乘客路线必须不可达');
});

test('validateScene 报告开放端与统计', () => {
  const st = assemblyWith([
    ['airlock', 0, 0, 0],
    ['corr-straight', 0, 0.5, 4],
  ]);
  const acc = validateScene(st, { allowOpenEnds: true, targets: [], spacing: [] });
  assert.ok(acc.stats.openEnds > 0);
  assert.ok(acc.warnings.length > 0);
});
