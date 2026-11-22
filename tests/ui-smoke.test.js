// 界面-内核集成的无头冒烟：回放生成日志、驱动视窗图元、可行连接查询
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, makeSpec } from '../kernel/generator.js';
import { replayLog } from '../kernel/solver.js';
import { newAssembly, makePlacement, addPlacement, feasibleConnections } from '../kernel/assembly.js';
import { showState } from '../ui/sceneview.js';

function fakeViewport() {
  return { boxes: [], frames: [], polylines: [], labels: [], grid: null, rendered: 0, render() { this.rendered += 1; } };
}

test('生成日志可逐步回放，且每步都能驱动视窗图元', () => {
  const r = generate(makeSpec('loop', 'ui-smoke'));
  assert.equal(r.ok, true);
  const spec = makeSpec('loop', 'ui-smoke');
  const vp = fakeViewport();
  let sawFrames = false;
  for (let i = 0; i < r.log.length; i++) {
    const state = replayLog(spec, r.log, i);
    showState(vp, state, { bounds: spec.bounds });
    assert.ok(vp.boxes.length > 0, `第 ${i} 步应有碰撞体图元`);
    if (vp.frames.length > 0) sawFrames = true;
  }
  assert.ok(sawFrames, '回放过程中应出现开放端门框');
  assert.ok(vp.rendered > 0);
});

test('可行连接：入口开放端能列出合法模块', () => {
  const spec = { allowOpenEnds: true, targets: [], spacing: [], bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 8, z: 20 } }, modules: {} };
  const st = newAssembly(spec);
  addPlacement(st, makePlacement('airlock', 0, { x: 0, z: 0 }), []);
  const end = st.openEnds[0];
  const feas = feasibleConnections(st, end);
  assert.ok(feas.length > 0, '入口 C2 开放端应有可行连接');
  assert.ok(feas.every((f) => f.type !== 'hangar'), 'C4 模块不应出现在 C2 开放端');
  // 放一个可行连接后，开放端数量应变化合理
  const before = st.openEnds.length;
  const f = feas.find((x) => x.type === 'corr-straight');
  addPlacement(st, makePlacement(f.type, f.rot, f.pos), []);
  assert.ok(st.openEnds.length >= before - 1);
});
