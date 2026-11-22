import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { loadBuiltinKits } from '../kernel/kitio.js';
import { rebuildManifest } from '../kernel/rebuild.js';
import { generate, makeSpec } from '../kernel/generator.js';

loadBuiltinKits();

test('旧样例全部运行到底：out/ 既有清单重建核验通过', () => {
  const files = readdirSync('out').filter((f) => f.startsWith('manifest-') && f.endsWith('.json'));
  assert.ok(files.length >= 5, '应有多份既有样例清单');
  for (const f of files) {
    const m = JSON.parse(readFileSync(`out/${f}`, 'utf8'));
    const r = rebuildManifest(m);
    assert.equal(r.ok, true, `${f} 重建失败：${r.checks.filter((c) => !c.ok).map((c) => `${c.name}:${c.detail}`).join(' | ')}`);
  }
});

test('新清单（v2）重建：模块源文件与部件身份哈希核验', () => {
  const g = generate(makeSpec('deck', 'rebuild-1'));
  assert.equal(g.ok, true);
  const r = rebuildManifest(g.manifest);
  assert.equal(r.ok, true, r.checks.filter((c) => !c.ok).map((c) => c.name).join(','));
  const names = r.checks.map((c) => c.name);
  assert.ok(names.includes('部件身份哈希一致'));
  assert.ok(names.includes('模块源文件记录'));
  assert.ok(r.checks.find((c) => c.name === '模块源文件记录').detail.includes('deck-kit'));
});

test('篡改清单（移动模块）重建必须失败，不允许伪报', () => {
  const g = generate(makeSpec('deck', 'rebuild-1'));
  const m = JSON.parse(JSON.stringify(g.manifest));
  m.placements[3].pos.x += 1.3;
  const r = rebuildManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => !c.ok));
});

test('篡改部件身份哈希：重建核验报出', () => {
  const g = generate(makeSpec('deck', 'rebuild-1'));
  const m = JSON.parse(JSON.stringify(g.manifest));
  m.moduleTable['deck-hall'].hash = 'deadbeef';
  const r = rebuildManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.checks.find((c) => c.name === '部件身份哈希一致').ok === false);
});
