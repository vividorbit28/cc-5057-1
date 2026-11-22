import test from 'node:test';
import assert from 'node:assert/strict';
import { bruteForce, crossCheck } from '../kernel/exhaustive.js';
import { solve } from '../kernel/solver.js';

const tinyOk = {
  seed: 'tiny-ok',
  entrance: 'airlock',
  modules: { 'corr-straight': 1, 'bay-med': 1 },
  targets: ['medbay'],
  spacing: [],
  bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 8, z: 20 } },
  budget: 5000,
};

const tinyCorner = {
  seed: 'tiny-corner',
  entrance: 'airlock',
  modules: { 'corr-corner': 1, cap: 1 },
  targets: [],
  spacing: [],
  bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 8, z: 20 } },
  budget: 5000,
};

const tinyUnsat = {
  seed: 'tiny-unsat',
  entrance: 'airlock',
  modules: { 'bay-med': 1, 'bay-hydro': 1 }, // 两个单门舱：第二个无处可接
  targets: [],
  spacing: [],
  bounds: { min: { x: -20, z: -20 }, max: { x: 20, y: 8, z: 20 } },
  budget: 5000,
};

test('穷举：小型可解规格存在有效装配', () => {
  const bf = bruteForce(tinyOk);
  assert.ok(bf.valid.length > 0, '应枚举出有效装配');
});

test('交叉核对：求解器与穷举结论一致，且求解器解在穷举集合中', () => {
  for (const spec of [tinyOk, tinyCorner, tinyUnsat]) {
    const cc = crossCheck(spec);
    assert.equal(cc.agree, true, `${spec.seed} 结论不一致: ${JSON.stringify(cc)}`);
    if (cc.solverSat) assert.equal(cc.solverInBruteSet, true, '求解器解必须在穷举集合中');
  }
});

test('交叉核对：穷举有效解全部通过几何碰撞与导航验收', () => {
  const cc = crossCheck(tinyOk);
  assert.equal(cc.acceptanceFailures.length, 0, JSON.stringify(cc.acceptanceFailures));
});

test('不可满足小规格：求解器给出失败而非死循环', () => {
  const r = solve(tinyUnsat);
  assert.equal(r.ok, false);
  assert.ok(r.stats.nodes <= 5000 + 1);
});
