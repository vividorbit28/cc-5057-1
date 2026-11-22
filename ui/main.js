// 主控：生成面板 + 决策日志逐步回放 + 结果区（可行连接/验收/失败解释/内核反馈/清单）
import { MODULES, getKits } from '../kernel/modules.js';
import { generate, makeSpec, PRESETS } from '../kernel/generator.js';
import { replayLog } from '../kernel/solver.js';
import { validateNav } from '../kernel/validate.js';
import { getFeedback, recordFeedback } from '../kernel/feedback.js';
import { registerKitData, measureModuleClearance, kitCatalogFor, moduleTableFor } from '../kernel/kit.js';
import { Viewport } from './viewport.js';
import { showState } from './sceneview.js';
import { createEditor } from './editor.js';

const $ = (id) => document.getElementById(id);
const vp = new Viewport($('view'));

const app = {
  mode: 'manual',
  gen: null,        // {spec, log, result}
  replayIndex: -1,
  playing: null,
};

// ---------- 结果区渲染 ----------
const ui = {
  log(msg) {
    const el = $('log-list');
    const div = document.createElement('div');
    div.className = 'log-line ui-log';
    div.textContent = `[界面] ${msg}`;
    el.prepend(div);
  },
  renderEnds(state, selectedEnd) {
    const box = $('ends-list');
    box.innerHTML = '';
    if (!selectedEnd) $('feasible-list').innerHTML = '';
    if (state.openEnds.length === 0) {
      box.innerHTML = '<div class="muted">无开放端（全部封闭）</div>';
      return;
    }
    for (const e of state.openEnds) {
      const b = document.createElement('button');
      b.className = 'end-btn' + (selectedEnd && selectedEnd.key === e.key ? ' active' : '');
      b.textContent = `${e.type} @(${e.center.x.toFixed(1)}, ${e.center.z.toFixed(1)}) ${dirName(e.dir)} · ${e.uid}`;
      b.onclick = () => editor.selectEnd(e);
      box.appendChild(b);
    }
  },
  renderFeasible(list, end) {
    const box = $('feasible-list');
    box.innerHTML = `<div class="muted">对 ${end.type} @(${end.center.x.toFixed(1)}, ${end.center.z.toFixed(1)}) 的可行连接 ${list.length} 个：</div>`;
    for (const f of list) {
      const b = document.createElement('button');
      b.className = 'feasible-btn';
      b.textContent = `${f.label} rot${f.rot} @(${f.pos.x.toFixed(1)}, ${f.pos.z.toFixed(1)})${f.loops ? ' ·成环' : ''}`;
      b.onclick = () => editor.placeFeasible(f);
      box.appendChild(b);
    }
  },
  renderGhostReasons(reasons) {
    $('ghost-reasons').textContent = reasons.length ? `内核拒绝：${reasons[0]}` : '';
  },
  renderAcceptance(acc) {
    const box = $('acceptance');
    if (!acc) { box.innerHTML = '<div class="muted">尚未验收</div>'; return; }
    const lines = [];
    lines.push(`<div class="${acc.ok ? 'ok' : 'bad'}">${acc.ok ? '验收通过' : '验收未通过'}</div>`);
    lines.push(`<div>模块 ${acc.stats.modules} · 连接 ${acc.stats.connections} · 开放端 ${acc.stats.openEnds}</div>`);
    for (const p of acc.nav.paths) lines.push(`<div class="ok">乘客路线 → ${p.to}：${p.length.toFixed(1)}m</div>`);
    for (const b of acc.nav.blockedBy ?? []) {
      lines.push(`<div class="warn">连通阻断：${b.type}(${b.uid}) ${b.labels.join('、') || '墙体'} · ${b.cells} 格</div>`);
    }
    for (const e of acc.errors) lines.push(`<div class="bad">${e}</div>`);
    for (const w of acc.warnings) lines.push(`<div class="warn">${w}</div>`);
    box.innerHTML = lines.join('');
  },
  renderKitFindings(results) {
    const box = $('kit-findings');
    const lines = [];
    for (const r of results ?? []) {
      if (!r?.kit) { lines.push('<div class="finding error">套件格式非法，已拒绝注册</div>'); continue; }
      lines.push(`<div class="kit-heading">${r.kit.label} <span class="mono muted">${r.kit.id}@${r.kit.version}</span></div>`);
      if (r.kit.source?.origin) lines.push(`<div class="finding muted">来源 ${r.kit.source.origin}</div>`);
      for (const f of r.findings ?? []) {
        lines.push(`<div class="finding ${f.level}">${f.text}</div>`);
      }
      if ((r.findings ?? []).length === 0) lines.push('<div class="finding info">校验通过，无异常发现</div>');
    }
    box.innerHTML = lines.join('') || '<div class="muted">仅内置核心套件</div>';
  },
  renderConflict(conflict, reason) {
    const box = $('conflict');
    if (!conflict) { box.innerHTML = ''; return; }
    const lines = [`<div class="bad">生成失败：${reason}（深度 ${conflict.atDepth}）</div>`];
    if (conflict.conflictingModules.length) {
      lines.push('<div>相关模块：</div>');
      for (const m of conflict.conflictingModules) lines.push(`<div class="mono">  ${m.type} (${m.uid})</div>`);
    }
    lines.push('<div>冲突条件：</div>');
    for (const c of conflict.conditions) lines.push(`<div class="bad mono">  ${c}</div>`);
    if (conflict.tried?.length) {
      lines.push(`<details><summary>最深候选尝试 ${conflict.tried.length} 条</summary>` +
        conflict.tried.slice(0, 12).map((t) => `<div class="mono muted">${t.desc} — ${t.reasons[0] ?? ''}</div>`).join('') + '</details>');
    }
    box.innerHTML = lines.join('');
  },
  renderLogEvents(log, activeIdx) {
    const box = $('log-list');
    box.innerHTML = '';
    log.forEach((e, i) => {
      const div = document.createElement('div');
      div.className = 'log-line kind-' + e.kind + (i === activeIdx ? ' active' : '');
      div.textContent = `${i}. ${e.note ?? e.kind}`;
      if (e.sacrificedExits?.length) div.textContent += `（牺牲出口：${e.sacrificedExits.slice(0, 3).join('；')}${e.sacrificedExits.length > 3 ? '…' : ''}）`;
      div.onclick = () => setReplay(i);
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  },
  renderFeedback() {
    const box = $('feedback');
    const fb = getFeedback();
    box.innerHTML = fb.length
      ? fb.slice(-8).map((f) => `<div class="mono muted">[${f.source}] ${f.kind}${f.reasons ? '：' + f.reasons[0] : ''}${f.reason ? '：' + f.reason : ''}</div>`).join('')
      : '<div class="muted">暂无反馈</div>';
  },
  showRot(rot) { $('rot-indicator').textContent = `朝向 rot${rot}`; },
};

function dirName(d) {
  if (d.x === 1) return '东';
  if (d.x === -1) return '西';
  if (d.z === 1) return '南';
  return '北';
}

// ---------- 手动拼装 ----------
const editor = createEditor({ vp, ui });

function buildPalette() {
  const box = $('palette');
  box.innerHTML = '';
  for (const kit of getKits()) {
    const h = document.createElement('div');
    h.className = 'kit-heading';
    h.textContent = kit.label;
    box.appendChild(h);
    for (const def of Object.values(MODULES).filter((d) => d.kit === kit.id)) {
      const b = document.createElement('div');
      b.className = 'palette-item';
      b.draggable = true;
      b.textContent = `${def.label} (${def.type})`;
      const cl = measureModuleClearance(def);
      b.title = `尺寸 ${def.size.x}×${def.size.y}×${def.size.z} · 接口 ${def.interfaces.map((i) => `${i.id}:${i.type}@${i.face}`).join(', ') || '无'}`
        + (cl !== null ? ` · 实测通行高度 ${cl}m` : '')
        + (def.incompatible ? ` · 故意不兼容：${def.incompatible.reason}` : '');
      b.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/module', def.type);
        editor.setDragType(def.type);
      });
      box.appendChild(b);
    }
  }
}

// 套件加载：图形入口启动时从 kits/ 目录取套件文件注册；失败时回退内置核心套件并提示
async function loadKits() {
  try {
    const idx = await fetch('/kits/index.json').then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    const results = [];
    for (const f of idx.kits ?? []) {
      const data = await fetch(`/kits/${f}`).then((r) => r.json());
      results.push(registerKitData(data));
    }
    return results;
  } catch (e) {
    ui.log(`套件目录加载失败（${e.message}），仅使用内置核心套件`);
    return [];
  }
}

// ---------- 生成与回放 ----------
function setReplay(i) {
  if (!app.gen) return;
  const { spec, log } = app.gen;
  app.replayIndex = Math.max(0, Math.min(i, log.length - 1));
  const state = replayLog(spec, log, app.replayIndex);
  let navPaths = [];
  if (app.replayIndex === log.length - 1 && app.gen.result.ok) {
    const nav = validateNav(state, spec);
    navPaths = nav.paths.map((p) => ({
      pts: p.cells.map((c) => ({ x: nav.grid.minX + (c.ix + 0.5) * nav.grid.c, z: nav.grid.minZ + (c.iz + 0.5) * nav.grid.c })),
      color: '#ff5252',
    }));
  }
  showState(vp, state, { bounds: spec.bounds, navPaths });
  ui.renderLogEvents(log, app.replayIndex);
  $('replay-pos').textContent = `${app.replayIndex + 1}/${log.length}`;
}

function runGenerate() {
  stopPlay();
  const preset = $('preset').value;
  const seed = $('seed').value || 'demo-1';
  const spec = makeSpec(preset, seed);
  ui.log(`内核求解：${PRESETS[preset].label} / 种子 ${seed}`);
  const t0 = performance.now();
  const result = generate(spec);
  const ms = (performance.now() - t0).toFixed(0);
  app.gen = { spec, log: result.log, result };
  app.mode = 'replay';

  if (result.ok) {
    ui.log(`生成成功（${ms}ms）：模块 ${result.manifest.acceptance.stats.modules}，连接 ${result.manifest.acceptance.stats.connections}`);
    ui.renderConflict(null);
    ui.renderAcceptance(result.acceptance);
    $('save-manifest').disabled = false;
  } else {
    ui.log(`生成失败：${result.reason}，冲突条件 ${result.conflict?.conditions.length ?? 0} 条`);
    ui.renderConflict(result.conflict, result.reason);
    ui.renderAcceptance(null);
    $('save-manifest').disabled = true;
  }
  ui.renderFeedback();
  setReplay(result.log.length - 1);
}

function stopPlay() {
  if (app.playing) { clearInterval(app.playing); app.playing = null; $('play').textContent = '自动播放'; }
}

function saveManifest() {
  let data;
  if (app.mode === 'replay' && app.gen?.result.ok) {
    data = app.gen.result.manifest;
  } else {
    const acc = editor.accept();
    const usedTypes = editor.state.order.map((uid) => editor.state.placements.get(uid).type);
    data = {
      format: 'orbital-station-manifest/2',
      seed: '(手动拼装)',
      spec: editor.spec,
      kits: kitCatalogFor(usedTypes),
      moduleTable: moduleTableFor(usedTypes),
      placements: editor.state.order.map((uid) => {
        const p = editor.state.placements.get(uid);
        return { uid: p.uid, type: p.type, rot: p.rot, pos: p.pos };
      }),
      connections: editor.state.connections,
      openEnds: editor.state.openEnds,
      acceptance: acc,
      routes: (acc.nav?.paths ?? []).map((p) => ({ to: p.to, length: p.length, pts: p.pts })),
      feedback: getFeedback(),
    };
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `station-manifest-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  ui.log('清单已导出');
}

// ---------- 启动 ----------
async function boot() {
  vp.resize();
  window.addEventListener('resize', () => { vp.resize(); editor.refresh(); });

  const kitResults = await loadKits();
  ui.renderKitFindings(kitResults);
  buildPalette();
  const sel = $('preset');
  for (const [k, v] of Object.entries(PRESETS)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = v.label;
    sel.appendChild(o);
  }
  sel.value = 'medium';

  $('generate').onclick = runGenerate;
  $('step-back').onclick = () => setReplay(app.replayIndex - 1);
  $('step-fwd').onclick = () => setReplay(app.replayIndex + 1);
  $('step-start').onclick = () => setReplay(0);
  $('step-end').onclick = () => setReplay(app.gen ? app.gen.log.length - 1 : 0);
  $('play').onclick = () => {
    if (app.playing) return stopPlay();
    $('play').textContent = '暂停';
    app.playing = setInterval(() => {
      if (!app.gen || app.replayIndex >= app.gen.log.length - 1) return stopPlay();
      setReplay(app.replayIndex + 1);
    }, 350);
  };
  $('accept').onclick = () => editor.accept();
  $('save-manifest').onclick = saveManifest;
  $('rot-left').onclick = () => { editor.rotate(-1); ui.showRot(editor.ed.rot); };
  $('rot-right').onclick = () => { editor.rotate(1); ui.showRot(editor.ed.rot); };
  $('remove-selected').onclick = () => editor.removeSelected();
  $('back-manual').onclick = () => { app.mode = 'manual'; stopPlay(); editor.refresh(); };

  ui.renderFeedback();
  editor.refresh();
}

boot();
