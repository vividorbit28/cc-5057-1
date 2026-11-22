import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBuiltinKits } from '../kernel/kitio.js';
import { MODULES, getKits } from '../kernel/modules.js';
import {
  validateKit, measureModuleClearance, moduleConnectivity, kitCatalogFor, moduleTableFor,
  registerKitData,
} from '../kernel/kit.js';
import { NAV_CLEARANCE } from '../kernel/validate.js';

const results = loadBuiltinKits();

test('套件注册：双层站台套件进入注册表，部件身份齐全', () => {
  const deckTypes = ['deck-hall', 'deck-corner', 'deck-link-low', 'deck-link-high', 'deck-service', 'deck-cargo'];
  for (const t of deckTypes) {
    assert.ok(MODULES[t], `${t} 应已注册`);
    assert.equal(MODULES[t].kit, 'deck-kit');
    assert.ok(MODULES[t].hash, '应有部件身份哈希');
  }
  const kit = getKits().find((k) => k.id === 'deck-kit');
  assert.ok(kit.source?.origin, '套件必须保存来源');
  assert.ok(Object.keys(kit.params ?? {}).length > 0, '套件必须保存参数');
});

test('套件校验通过，且如实报告故意不兼容部件与异高接头对', () => {
  const v = validateKit('deck-kit');
  assert.equal(v.ok, true, JSON.stringify(v.findings.filter((f) => f.level === 'error')));
  const incompat = v.findings.find((f) => f.code === 'incompatible-declared');
  assert.ok(incompat, '应报告故意不兼容部件');
  assert.ok(incompat.text.includes('deck-service') && incompat.text.includes('D1'));
  const pair = v.findings.find((f) => f.code === 'clearance-variant');
  assert.ok(pair, '应报告同尺寸异通行高接头对');
  assert.ok(pair.text.includes('回溯'), '异高接头结论必须解释何时必须回溯');
  assert.deepEqual([...pair.modules].sort(), ['deck-link-high', 'deck-link-low']);
});

test('通行高度实测：同尺寸接头 1.1m vs 3.0m', () => {
  const low = measureModuleClearance(MODULES['deck-link-low']);
  const high = measureModuleClearance(MODULES['deck-link-high']);
  assert.equal(low, 1.1);
  assert.equal(high, 3.0);
  assert.ok(low < NAV_CLEARANCE && high >= NAV_CLEARANCE);
});

test('舱内连通：低矮件在乘客净高下不连通，在其声明净高下连通', () => {
  assert.equal(moduleConnectivity(MODULES['deck-link-low'], NAV_CLEARANCE).ok, false);
  assert.equal(moduleConnectivity(MODULES['deck-link-low'], 1.0).ok, true);
  for (const t of ['deck-hall', 'deck-corner', 'deck-link-high', 'deck-cargo', 'deck-service']) {
    assert.equal(moduleConnectivity(MODULES[t], NAV_CLEARANCE).ok, true, `${t} 舱内应连通`);
  }
});

test('故意不兼容部件若未声明原因，套件校验报错', () => {
  const bad = {
    format: 'orbital-station-kit/1', id: 'bad-kit', version: '0.1',
    source: { origin: 'test' }, params: { passengerClearance: 2.0 },
    interfaceTypes: { X9: { w: 1.0, h: 2.0, label: '孤立接口 X9' } },
    modules: [
      { type: 'bad-pod', label: '孤立舱', size: { x: 3, y: 3, z: 3 }, interfaces: [{ id: 'A', type: 'X9', face: 'N', u: 1.5 }] },
    ],
  };
  const r = registerKitData(bad);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.code === 'incompatible-undeclared'));
});

test('套件目录与接口资料：只含用到的套件，模块表带接口与实测净高', () => {
  const catalog = kitCatalogFor(['deck-hall', 'corr-straight']);
  assert.deepEqual(catalog.map((k) => k.id).sort(), ['core', 'deck-kit']);
  assert.ok(catalog.every((k) => k.source && k.params && k.hash));
  const table = moduleTableFor(['deck-link-low']);
  assert.equal(table['deck-link-low'].clearance, 1.1);
  assert.equal(table['deck-link-low'].interfaces.length, 2);
  assert.equal(table['deck-link-low'].interfaces[0].type, 'C2');
});
