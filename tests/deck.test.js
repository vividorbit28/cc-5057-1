import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBuiltinKits } from '../kernel/kitio.js';
import { generate, makeSpec } from '../kernel/generator.js';
import { solve } from '../kernel/solver.js';
import { rebuildPartial, planCompletion } from '../kernel/reverse.js';
import { sealedUnreachableTargets } from '../kernel/validate.js';

loadBuiltinKits();

test('双层站台预设可生成可进入关卡：验收通过且有演示路线', () => {
  const r = generate(makeSpec('deck', 'demo-2'));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.conflict?.conditions));
  assert.equal(r.acceptance.ok, true);
  const types = r.manifest.placements.map((p) => p.type);
  for (const t of ['deck-hall', 'deck-corner', 'deck-link-high', 'deck-link-low', 'deck-cargo']) {
    assert.ok(types.includes(t), `装配应包含 ${t}`);
  }
  assert.ok(r.manifest.routes.length >= 2, '应有多条演示路线');
  for (const route of r.manifest.routes) {
    assert.ok(route.pts.length > 1 && route.length > 0, '演示路线必须有世界坐标点列');
  }
});

test('清单 v2 保存种子、模块源文件与可拼装接口资料', () => {
  const r = generate(makeSpec('deck', 'demo-2'));
  const m = r.manifest;
  assert.equal(m.format, 'orbital-station-manifest/2');
  assert.equal(m.seed, 'demo-2');
  const kitIds = m.kits.map((k) => k.id).sort();
  assert.deepEqual(kitIds, ['core', 'deck-kit']);
  const deckKit = m.kits.find((k) => k.id === 'deck-kit');
  assert.equal(deckKit.source.origin, 'kits/deck-kit.kit.json');
  assert.ok(deckKit.params.passengerClearance > 0);
  assert.ok(deckKit.hash);
  // 不是美术网格：每个用到的模块都有接口类型/朝向/尺寸与实测通行高度
  for (const [t, info] of Object.entries(m.moduleTable)) {
    assert.ok(info.hash && info.size && Array.isArray(info.interfaces), `${t} 缺接口资料`);
    for (const i of info.interfaces) {
      assert.ok(i.type && i.face && i.w > 0 && i.h > 0, `${t} 接口缺类型/朝向/尺寸`);
    }
    assert.ok(info.clearance === null || info.clearance > 0);
  }
  assert.equal(m.moduleTable['deck-link-low'].clearance, 1.1);
});

test('双层站台生成可复现：同种子同清单（字节级）', () => {
  const a = generate(makeSpec('deck', 'demo-2'));
  const b = generate(makeSpec('deck', 'demo-2'));
  assert.equal(JSON.stringify(a.manifest), JSON.stringify(b.manifest));
});

test('故意不兼容库存：求解失败并指出接口类型互不匹配', () => {
  const r = generate(makeSpec('deck-impossible', 'demo-x'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsatisfiable');
  const text = r.conflict.conditions.join('\n');
  assert.ok(text.includes('deck-service'), '应点名检修舱');
  assert.ok(text.includes('D1'), '应指出 D1 接口无配合件');
});

test('套件未加载时规格引用未知模块：结构化失败而非异常', () => {
  const r = solve({ seed: 'nok', entrance: 'airlock', modules: { 'ghost-pod': 1 }, targets: [], spacing: [], budget: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-module');
  assert.ok(r.conflict.conditions[0].includes('ghost-pod'));
});

test('低矮件封死目标时求解器回溯并留下封死事件', () => {
  // 库存只给低矮件桥接入口与大厅：几何被迫，求解器必须回溯更换布局
  const r = solve({
    seed: 'b', entrance: 'airlock',
    modules: { 'deck-link-low': 2, 'deck-hall': 1, cap: 3 },
    targets: ['deck'], spacing: [],
    bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 10, z: 20 } },
    budget: 50000,
  });
  // 该规格可解（大厅可直接贴入口，低矮件挂支路），且过程中出现过封死回溯
  assert.equal(r.ok, true);
  assert.ok(r.log.some((e) => e.kind === 'nav-sealed'), '应有 nav-sealed 回溯事件');
});

test('封死判定：目标区域无开放端时判定连通不可恢复', () => {
  // 被迫链：入口—低矮件—大厅（大厅其余门已封端盖）→ 大厅被封死
  const forcedPartial = [
    { uid: 'm1', type: 'airlock', rot: 0, pos: { x: 0, z: 0 } },
    { uid: 'm2', type: 'deck-hall', rot: 0, pos: { x: -2, z: 7 } },
  ];
  const spec = { targets: ['deck'], spacing: [], bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 10, z: 20 } }, modules: {} };
  const lowDone = planCompletion(rebuildPartial(forcedPartial, spec).state, { 'deck-link-low': 1, cap: 3 }, { seed: 't-low' });
  const sealed = sealedUnreachableTargets(lowDone.state, spec);
  assert.ok(sealed.some((s) => s.includes('deck-hall')), `应判定大厅封死，实测：${sealed}`);
  // 同几何换高通行变体：无封死
  const highDone = planCompletion(rebuildPartial(forcedPartial, spec).state, { 'deck-link-high': 1, cap: 3 }, { seed: 't-high' });
  assert.deepEqual(sealedUnreachableTargets(highDone.state, spec), []);
});
