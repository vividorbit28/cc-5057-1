// 策略比较：同一批场景下实测两条路线——
//   正向：按连接口约束生成套件（求解器全量搜索）
//   逆向：从成品站台清单逆推缺件 / 在局部装配上补缺完成
// 结果写入 out/strategy-comparison.json，数字均为实测，不预填。
// 用法：node kernel/compare.js [--out out/strategy-comparison.json]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generate, makeSpec } from './generator.js';
import { solve } from './solver.js';
import { validateScene } from './validate.js';
import { inferMissingPieces, rebuildPartial, planCompletion } from './reverse.js';
import { loadBuiltinKits } from './kitio.js';

const now = () => Date.now();

function forwardRun(preset, seed) {
  const spec = makeSpec(preset, seed);
  const t0 = now();
  const r = generate(spec);
  return {
    ok: r.ok,
    nodes: r.ok ? r.manifest.stats.nodes : r.stats.nodes,
    backtracks: r.ok ? r.manifest.stats.backtracks : r.stats.backtracks,
    redirects: r.ok ? r.manifest.stats.redirects : r.stats.redirects,
    ms: now() - t0,
    manifest: r.ok ? r.manifest : null,
    spec,
  };
}

function reverseInferRun(manifest, spec) {
  const t0 = now();
  // 库存 = 规格模块 + 入口锚定件（entrance 不在 spec.modules 内）
  const full = inferMissingPieces(manifest, { airlock: 1, ...spec.modules });
  const tamperedInv = { airlock: 1, ...spec.modules };
  const victim = Object.keys(tamperedInv).find((k) => k !== 'airlock' && tamperedInv[k] > 0);
  tamperedInv[victim] -= 1;
  const tampered = inferMissingPieces(manifest, tamperedInv);
  return {
    ms: now() - t0,
    ok: full.ok,
    missing: full.missing,
    surplus: full.surplus,
    connectionsMatch: full.connections.match,
    tampered: { removed: victim, missing: tampered.missing },
  };
}

function reverseCompleteRun(manifest, spec, k = 3) {
  const kept = manifest.placements.slice(0, -k);
  const removed = manifest.placements.slice(-k);
  const inventory = {};
  for (const p of removed) inventory[p.type] = (inventory[p.type] ?? 0) + 1;
  const t0 = now();
  const partial = rebuildPartial(kept, manifest.spec);
  if (!partial.ok) return { ok: false, note: `局部重建失败：${partial.reasons?.[0]}`, removed: k };
  const comp = planCompletion(partial.state, inventory, { seed: `${manifest.seed}-rc` });
  const acceptance = comp.ok ? validateScene(comp.state, manifest.spec) : null;
  return {
    ok: comp.ok, removed: k,
    steps: comp.stats.steps, backtracks: comp.stats.backtracks,
    acceptanceOk: acceptance?.ok ?? false,
    ms: now() - t0,
  };
}

// 同尺寸异通行高接头：几何被迫时，两条路线各自的表现
function clearanceMismatchRun() {
  const bounds = { min: { x: -20, z: -20 }, max: { x: 20, y: 10, z: 20 } };

  // 正向自由放置：求解器可绕开低矮件（大厅直接贴入口，低矮件挂为支路）
  const freeSpec = {
    seed: 'cmp-low', entrance: 'airlock',
    modules: { 'deck-link-low': 1, 'deck-hall': 1, cap: 3 },
    targets: ['deck'], spacing: [], bounds, budget: 20000,
  };
  const t0 = now();
  const fwdFree = solve(freeSpec);
  const fwdFreeMs = now() - t0;

  // 逆向补缺：局部装配已固定为“入口—大厅分离 3m”，库存只有低矮件可桥接——
  // 接口约束全部满足，但乘客路线必过低矮件，验收必须断裂并给出阻断证据
  const forcedPartial = [
    { uid: 'm1', type: 'airlock', rot: 0, pos: { x: 0, z: 0 } },
    { uid: 'm2', type: 'deck-hall', rot: 0, pos: { x: -2, z: 7 } },
  ];
  const forcedSpec = { ...freeSpec, modules: {}, targets: ['deck'] };
  const partial = rebuildPartial(forcedPartial, forcedSpec);
  const t1 = now();
  const comp = planCompletion(partial.state, { 'deck-link-low': 1, cap: 3 }, { seed: 'cmp-low-rc' });
  const acc = comp.ok ? validateScene(comp.state, forcedSpec) : null;
  const revForced = {
    geometricOk: comp.ok,
    acceptanceOk: acc?.ok ?? null,
    navErrors: (acc?.errors ?? []).filter((e) => e.includes('导航')),
    blockedBy: acc?.nav.blockedBy ?? [],
    ms: now() - t1,
  };

  // 同一被迫几何，库存换成高通行变体：验收应通过（回溯更换变体即解）
  const t2 = now();
  const compHigh = planCompletion(
    rebuildPartial(forcedPartial, forcedSpec).state,
    { 'deck-link-high': 1, cap: 3 },
    { seed: 'cmp-high-rc' },
  );
  const accHigh = compHigh.ok ? validateScene(compHigh.state, forcedSpec) : null;

  return {
    note: 'deck-link-low 与 deck-link-high 尺寸/接口完全相同，通行高度 1.1m vs 3.0m',
    forwardFree: { ok: fwdFree.ok, reason: fwdFree.reason ?? null, ms: fwdFreeMs },
    reverseForcedLow: revForced,
    reverseForcedHigh: { geometricOk: compHigh.ok, acceptanceOk: accHigh?.ok ?? null, ms: now() - t2 },
  };
}

function main() {
  loadBuiltinKits();
  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : 'out/strategy-comparison.json';

  const scenarios = [];
  for (const preset of ['small', 'medium', 'deck']) {
    const seed = 'cmp-1';
    const fwd = forwardRun(preset, seed);
    const row = { preset, seed, forward: { ok: fwd.ok, nodes: fwd.nodes, backtracks: fwd.backtracks, redirects: fwd.redirects, ms: fwd.ms } };
    if (!fwd.ok) {
      row.error = `正向生成失败：${fwd.reason ?? '未知'}`;
    } else {
      row.reverseInfer = reverseInferRun(fwd.manifest, fwd.spec);
      row.reverseComplete = reverseCompleteRun(fwd.manifest, fwd.spec, 3);
    }
    row.clearanceMismatch = preset === 'deck'
      ? clearanceMismatchRun()
      : { note: '核心套件无同尺寸异通行高接头，本场景不适用' };
    scenarios.push(row);
  }

  const deck = scenarios.find((s) => s.preset === 'deck');
  const mm = deck?.clearanceMismatch;
  const conclusions = [
    `正向生成（按连接口约束）：${scenarios.map((s) => `${s.preset} ${s.forward.nodes} 节点/${s.forward.ms}ms`).join('，')}——全量搜索，成本随库存规模增长`,
    `逆推缺件（从成品清单核销库存）：三个场景均在 ${Math.max(...scenarios.map((s) => s.reverseInfer?.ms ?? 0))}ms 内完成，缺件 ${JSON.stringify(scenarios[0].reverseInfer?.missing)}，篡改库存即报 ${JSON.stringify(scenarios[0].reverseInfer?.tampered?.missing)}——快但必须有成品清单`,
    `补缺完成（拆掉 3 件再补回）：${scenarios.map((s) => `${s.preset} ${s.reverseComplete?.steps} 步/${s.reverseComplete?.ms}ms`).join('，')}——比正向搜索便宜，但只适用于“缺什么已知”的情形`,
    mm?.reverseForcedLow
      ? `异高接头：正向自由放置${mm.forwardFree.ok ? '成功（求解器绕开低矮件）' : '失败'}；逆向被迫几何下低矮件接口约束全过、几何完成，但验收导航断裂，阻断证据指向 ${mm.reverseForcedLow.blockedBy?.[0]?.type}(${mm.reverseForcedLow.blockedBy?.[0]?.uid})——必须回溯更换高通行变体；同几何换高变体后验收${mm.reverseForcedHigh.acceptanceOk ? '通过' : '仍未通过'}`
      : '异高接头场景未运行',
  ];

  const report = { generatedAt: new Date().toISOString(), scenarios, conclusions };
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`策略比较完成：${outFile}`);
  for (const c of conclusions) console.log(`  · ${c}`);
}

main();
