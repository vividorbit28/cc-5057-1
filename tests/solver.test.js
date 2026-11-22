import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, makeSpec } from '../kernel/generator.js';
import { solve } from '../kernel/solver.js';
import { validateScene } from '../kernel/validate.js';
import { newAssembly, makePlacement, addPlacement, checkPlacement } from '../kernel/assembly.js';
import { MODULES } from '../kernel/modules.js';

test('生成结果可复现：同种子同清单', () => {
  const a = generate(makeSpec('medium', 'seed-x'));
  const b = generate(makeSpec('medium', 'seed-x'));
  assert.equal(a.ok && b.ok, true);
  assert.equal(JSON.stringify(a.manifest), JSON.stringify(b.manifest));
});

test('不同种子给出不同装配', () => {
  const a = generate(makeSpec('medium', 'seed-a'));
  const b = generate(makeSpec('medium', 'seed-b'));
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(JSON.stringify(a.manifest.placements), JSON.stringify(b.manifest.placements));
});

test('成功场景通过几何碰撞与导航通路验收', () => {
  for (const preset of ['small', 'loop', 'medium', 'hangar', 'large']) {
    const r = generate(makeSpec(preset, `acc-${preset}`));
    assert.equal(r.ok, true, `${preset} 应可生成`);
    assert.equal(r.acceptance.ok, true);
    assert.equal(r.acceptance.errors.length, 0);
    assert.ok(r.acceptance.nav.paths.length >= 1, '应有乘客路线');
  }
});

test('不可满足规格返回结构化失败：相关模块与条件，且在预算内停止', () => {
  const r = generate(makeSpec('impossible', 'seed-f'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsatisfiable');
  assert.ok(r.conflict.conditions.length > 0, '应给出冲突条件');
  assert.ok(r.conflict.conditions.some((c) => c.includes('间距')), '应包含间距冲突条件');
  assert.ok(r.stats.nodes <= 20000 + 1, '不得无限重试');
});

test('闭环预设触发环路事件并记录牺牲出口', () => {
  const r = generate(makeSpec('loop', 'seed-loop'));
  assert.equal(r.ok, true);
  const kinds = r.log.map((e) => e.kind);
  assert.ok(kinds.includes('loop-commit') || kinds.includes('loop-reject'), '应有环路决策事件');
  const ev = r.log.find((e) => e.kind === 'loop-commit' || e.kind === 'loop-reject');
  assert.ok(Array.isArray(ev.sacrificedExits), '环路事件应记录牺牲出口');
  assert.ok(r.manifest.acceptance.stats.connections >= r.manifest.acceptance.stats.modules - 1);
});

test('回退事件记录被牺牲的出口', () => {
  const r = generate(makeSpec('medium', 'seed-bt'));
  assert.equal(r.ok, true);
  const bt = r.log.filter((e) => e.kind === 'global-backtrack');
  assert.ok(bt.length > 0, '应发生全局回退');
  assert.ok(bt.every((e) => Array.isArray(e.sacrificedExits)));
});

test('篡改场景（移动模块造成重叠/接口错位）必须被验收发现', () => {
  const r = generate(makeSpec('medium', 'seed-tamper'));
  assert.equal(r.ok, true);
  const state = r.state;
  const placements = [...state.placements.values()];
  const victim = placements[2];
  // 把模块平移 1.2m：既可能造成重叠，也必然让原连接接口错位
  victim.pos = { x: victim.pos.x + 1.2, y: 0, z: victim.pos.z + 0.7 };
  victim.aabb = { min: { x: victim.pos.x, y: 0, z: victim.pos.z }, max: { x: victim.pos.x + 4, y: 3, z: victim.pos.z + 4 } };
  const acc = validateScene(state, state.spec);
  assert.equal(acc.ok, false, '篡改后验收必须失败，不得掩盖');
  assert.ok(acc.errors.length > 0);
});

test('门洞被墙堵住的放置被拒绝（不得以遮挡掩盖接口不匹配）', () => {
  const spec = { bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 8, z: 20 } }, modules: {}, spacing: [], allowOpenEnds: true };
  const st = newAssembly(spec);
  // 一个直走廊，门朝内贴到另一个模块的实墙面
  const a = makePlacement('corr-straight', 0, { x: 0, z: 0 });   // 占 z 0..6，N 门在 (1.5,0)
  addPlacement(st, a, []);
  // 把 bay-med 贴在走廊 N 面：bay 的实墙堵住走廊 N 门 (1.5,0)，而 bay 自己的门在 (2,0) 也对不上
  const chk = checkPlacement(st, MODULES['bay-med'], 2, { x: -1, z: -6 }, null);
  assert.equal(chk.ok, false);
  assert.ok(chk.reasons.some((r) => r.code === 'door-blocked' || r.code === 'iface-mismatch' || r.code === 'overlap'));
});

test('接口类型不匹配（C2 对 C4）被拒绝', () => {
  const spec = { bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 8, z: 20 } }, modules: {}, spacing: [], allowOpenEnds: true };
  const st = newAssembly(spec);
  const wide = makePlacement('corr-wide', 0, { x: 0, z: 0 }); // C4 门在 (2,0) 朝 N
  addPlacement(st, wide, []);
  // 直走廊 C2 门对齐到 C4 门中心 (2,0)：类型不同
  const chk = checkPlacement(st, MODULES['corr-straight'], 0, { x: 0.5, z: -6 }, null);
  assert.equal(chk.ok, false);
  assert.ok(chk.reasons.some((r) => r.code === 'iface-mismatch' || r.code === 'door-blocked'));
});
