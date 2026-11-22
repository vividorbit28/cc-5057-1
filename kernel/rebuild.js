// 重建核验：读取生成清单，逐步重建装配并复验——
// 模块资产必须真实存在（部件身份哈希比对），重建结果必须符合清单约定。
// 任何不一致都如实报告并以非零码退出，不允许伪报。
// 用法：node kernel/rebuild.js <manifest.json...> | node kernel/rebuild.js --all [dir]
import { readFileSync, readdirSync } from 'node:fs';
import { MODULES } from './modules.js';
import { checkPlacement, addPlacement, newAssembly, resetUid } from './assembly.js';
import { validateScene } from './validate.js';
import { loadBuiltinKits } from './kitio.js';

export function rebuildManifest(manifest) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

  const fmt = manifest?.format;
  if (!check('清单格式', fmt === 'orbital-station-manifest/1' || fmt === 'orbital-station-manifest/2', `format=${fmt}`)) {
    return { ok: false, checks };
  }
  const v2 = fmt === 'orbital-station-manifest/2';

  // 部件身份：每个放置的模块类型真实存在；v2 清单还需与 moduleTable 哈希一致
  const types = [...new Set((manifest.placements ?? []).map((p) => p.type))];
  const missingTypes = types.filter((t) => !MODULES[t]);
  check('模块资产存在', missingTypes.length === 0,
    missingTypes.length ? `未注册类型：${missingTypes.join(', ')}` : `${types.length} 种模块均在注册表中`);
  if (v2 && manifest.moduleTable) {
    const badHash = types.filter((t) => MODULES[t] && manifest.moduleTable[t]?.hash !== MODULES[t].hash);
    check('部件身份哈希一致', badHash.length === 0,
      badHash.length ? `哈希不符：${badHash.join(', ')}` : `${types.length} 种模块哈希与注册表一致`);
    const kits = (manifest.kits ?? []).map((k) => `${k.id}@${k.version}#${k.hash}`);
    check('模块源文件记录', kits.length > 0, kits.join('；') || '无套件记录');
  } else {
    checks.push({ name: '模块源文件记录', ok: true, detail: 'v1 清单无套件/接口资料，按当前注册表核验（旧样例兼容）' });
  }

  // 逐步重建：每一步都必须通过内核放置检查
  resetUid(1);
  const spec = { ...(manifest.spec ?? {}), modules: {} };
  const state = newAssembly(spec);
  const rebuiltUids = [];
  let stepFailure = null;
  for (const [i, pl] of (manifest.placements ?? []).entries()) {
    const def = MODULES[pl.type];
    if (!def) { stepFailure = { i, uid: pl.uid, type: pl.type, reasons: ['类型未注册'] }; break; }
    const chk = checkPlacement(state, def, pl.rot, pl.pos, null);
    if (!chk.ok) {
      stepFailure = { i, uid: pl.uid, type: pl.type, reasons: chk.reasons.map((r) => r.text) };
      break;
    }
    addPlacement(state, chk.cand, chk.links);
    rebuiltUids.push(chk.cand.uid);
  }
  check('逐步重建通过内核检查', !stepFailure,
    stepFailure ? `第 ${stepFailure.i} 件 ${stepFailure.type}(${stepFailure.uid})：${stepFailure.reasons[0]}` : `${rebuiltUids.length} 件全部合法落位`);

  // 连接一致（按放置序号归一比较）
  const idxOf = new Map((manifest.placements ?? []).map((p, i) => [p.uid, i]));
  const norm = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const manifestConns = new Set((manifest.connections ?? [])
    .filter((c) => idxOf.has(c.a?.uid) && idxOf.has(c.b?.uid))
    .map((c) => norm(idxOf.get(c.a.uid), idxOf.get(c.b.uid))));
  const rebuiltIdx = new Map();
  rebuiltUids.forEach((uid, i) => rebuiltIdx.set(uid, i));
  const rebuiltConns = new Set(state.connections
    .filter((c) => rebuiltIdx.has(c.a.uid) && rebuiltIdx.has(c.b.uid))
    .map((c) => norm(rebuiltIdx.get(c.a.uid), rebuiltIdx.get(c.b.uid))));
  const connsMatch = manifestConns.size === rebuiltConns.size && [...manifestConns].every((k) => rebuiltConns.has(k));
  check('连接关系一致', connsMatch, `清单 ${manifestConns.size} 处 / 重建 ${rebuiltConns.size} 处`);

  // 复验：几何碰撞 + 接口审计 + 间距 + 导航通路
  const acceptance = validateScene(state, spec);
  check('重建装配通过验收', acceptance.ok, acceptance.errors[0] ?? `模块 ${acceptance.stats.modules} · 连接 ${acceptance.stats.connections} · 开放端 ${acceptance.stats.openEnds}`);

  // 与清单约定比对
  const want = manifest.acceptance?.stats;
  if (want) {
    const got = acceptance.stats;
    check('验收统计符合约定',
      want.modules === got.modules && want.connections === got.connections && want.openEnds === got.openEnds,
      `约定 ${want.modules}/${want.connections}/${want.openEnds} · 实测 ${got.modules}/${got.connections}/${got.openEnds}`);
  }
  const wantNav = manifest.acceptance?.nav?.length ?? null;
  if (wantNav !== null) {
    check('乘客路线数量符合约定', acceptance.nav.paths.length === wantNav,
      `约定 ${wantNav} 条 · 实测 ${acceptance.nav.paths.length} 条`);
  }

  return { ok: checks.every((c) => c.ok), checks, acceptance };
}

export function rebuildFile(path) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { path, ok: false, checks: [{ name: '读取清单', ok: false, detail: String(e.message ?? e) }] };
  }
  return { path, ...rebuildManifest(manifest) };
}

function main() {
  loadBuiltinKits();
  const args = process.argv.slice(2);
  let files = [];
  if (args[0] === '--all') {
    const dir = args[1] ?? 'out';
    files = readdirSync(dir).filter((f) => f.startsWith('manifest-') && f.endsWith('.json')).map((f) => `${dir}/${f}`);
  } else {
    files = args;
  }
  if (files.length === 0) {
    console.log('用法：node kernel/rebuild.js <manifest.json...> 或 node kernel/rebuild.js --all [dir]');
    process.exit(64);
  }
  let failed = 0;
  for (const f of files.sort()) {
    const r = rebuildFile(f);
    console.log(`\n== ${f}：${r.ok ? '重建核验通过' : '重建核验失败'}`);
    for (const c of r.checks ?? []) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`);
    if (!r.ok) failed += 1;
  }
  console.log(`\n共 ${files.length} 份清单，${files.length - failed} 份通过，${failed} 份失败`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
