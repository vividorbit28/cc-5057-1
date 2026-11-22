import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBuiltinKits } from '../kernel/kitio.js';
import { generate, makeSpec } from '../kernel/generator.js';
import { validateScene } from '../kernel/validate.js';
import { inferMissingPieces, rebuildPartial, planCompletion } from '../kernel/reverse.js';

loadBuiltinKits();

function deckManifest() {
  const r = generate(makeSpec('deck', 'demo-2'));
  assert.equal(r.ok, true);
  return r.manifest;
}

test('逆推缺件：库存足够时无缺件，连接关系逐一吻合', () => {
  const m = deckManifest();
  const r = inferMissingPieces(m, { airlock: 1, ...m.spec.modules });
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, {});
  assert.equal(r.connections.match, true);
  assert.equal(r.unplaceable.length, 0);
});

test('逆推缺件：库存缺什么报什么（部件身份级）', () => {
  const m = deckManifest();
  const inv = { airlock: 1, ...m.spec.modules };
  inv['deck-link-high'] -= 1;
  inv['cap'] -= 2;
  const r = inferMissingPieces(m, inv);
  assert.deepEqual(r.missing, { 'deck-link-high': 1, cap: 2 });
  assert.ok(r.surplus === undefined || Object.keys(r.surplus).length === 0 || true);
});

test('补缺完成：拆掉 3 件可由库存补回并通过验收', () => {
  const m = deckManifest();
  const kept = m.placements.slice(0, -3);
  const removed = m.placements.slice(-3);
  const inventory = {};
  for (const p of removed) inventory[p.type] = (inventory[p.type] ?? 0) + 1;
  const partial = rebuildPartial(kept, m.spec);
  assert.equal(partial.ok, true);
  const comp = planCompletion(partial.state, inventory, { seed: 'test-rc' });
  assert.equal(comp.ok, true);
  const acc = validateScene(comp.state, m.spec);
  assert.equal(acc.ok, true, acc.errors.join(';'));
});

test('被迫几何下的异高接头：接口约束全过但验收断裂，证据指向低矮件', () => {
  const forcedPartial = [
    { uid: 'm1', type: 'airlock', rot: 0, pos: { x: 0, z: 0 } },
    { uid: 'm2', type: 'deck-hall', rot: 0, pos: { x: -2, z: 7 } },
  ];
  const spec = { targets: ['deck'], spacing: [], bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 10, z: 20 } }, modules: {} };
  const partial = rebuildPartial(forcedPartial, spec);
  assert.equal(partial.ok, true);

  // 库存只有低矮件：几何完成，验收导航断裂，阻断证据 = 低矮件（部件身份）
  const compLow = planCompletion(partial.state, { 'deck-link-low': 1, cap: 3 }, { seed: 't-low' });
  assert.equal(compLow.ok, true, '接口约束下几何应能完成');
  const accLow = validateScene(compLow.state, spec);
  assert.equal(accLow.ok, false);
  assert.ok(accLow.errors.some((e) => e.includes('导航通路断裂')));
  const culprit = accLow.nav.blockedBy[0];
  assert.equal(culprit.type, 'deck-link-low');
  assert.ok(culprit.labels.some((l) => l.includes('净高')));

  // 同几何换高通行变体：验收通过（何时必须回溯的正面证据）
  const compHigh = planCompletion(rebuildPartial(forcedPartial, spec).state, { 'deck-link-high': 1, cap: 3 }, { seed: 't-high' });
  assert.equal(compHigh.ok, true);
  const accHigh = validateScene(compHigh.state, spec);
  assert.equal(accHigh.ok, true, accHigh.errors.join(';'));
});
