// CLI：node kernel/cli.js --preset medium --seed alpha [--out out]
// 命令行仅作辅助；图形入口见 README（node ui/server.js）
import { writeFileSync, mkdirSync } from 'node:fs';
import { generate, makeSpec, PRESETS } from './generator.js';
import { loadBuiltinKits } from './kitio.js';

loadBuiltinKits();

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const preset = arg('preset', 'medium');
const seed = arg('seed', 'demo-1');
const outDir = arg('out', 'out');

if (preset === 'list') {
  for (const [k, v] of Object.entries(PRESETS)) console.log(`${k}\t${v.label}`);
  process.exit(0);
}

const spec = makeSpec(preset, seed);
const r = generate(spec);

if (!r.ok) {
  console.log(`生成失败：${r.reason}（种子 ${seed}，预设 ${preset}）`);
  if (r.conflict) {
    console.log(`冲突深度 ${r.conflict.atDepth}，涉及模块：`);
    for (const m of r.conflict.conflictingModules) console.log(`  - ${m.type} (${m.uid})`);
    console.log('冲突条件：');
    for (const c of r.conflict.conditions) console.log(`  * ${c}`);
  }
  console.log(`搜索统计：${JSON.stringify(r.stats)}`);
  process.exit(2);
}

const a = r.manifest.acceptance;
console.log(`生成成功：${preset} / 种子 ${seed}`);
console.log(`模块 ${a.stats.modules} 个，连接 ${a.stats.connections} 处，开放端 ${a.stats.openEnds} 个`);
for (const p of a.nav) console.log(`乘客路线 -> ${p.to}：${p.length.toFixed(1)}m`);
console.log(`搜索统计：${JSON.stringify(r.manifest.stats)}`);
mkdirSync(outDir, { recursive: true });
const file = `${outDir}/manifest-${preset}-${seed}.json`;
writeFileSync(file, JSON.stringify(r.manifest, null, 2));
console.log(`清单已保存：${file}`);
