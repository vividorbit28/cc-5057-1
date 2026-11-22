import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, moduleShell, worldIfaces, ifaceGeom } from '../kernel/modules.js';
import { containsPoint } from '../kernel/geom.js';

test('每个模块接口的门洞中心落在模块边界面上', () => {
  for (const def of Object.values(MODULES)) {
    for (const i of def.interfaces) {
      const g = ifaceGeom(def, i);
      const onFace = Math.abs(g.center.x) < 1e-9 || Math.abs(g.center.z) < 1e-9
        || Math.abs(g.center.x - def.size.x) < 1e-9 || Math.abs(g.center.z - def.size.z) < 1e-9;
      assert.ok(onFace, `${def.type}:${i.id} 门洞不在面上`);
    }
  }
});

test('墙体在门洞处真实开洞，门旁仍是实心墙', () => {
  const def = MODULES['corr-straight']; // 3x3x6，N/S 面 C2 门 u=1.5
  const shell = moduleShell(def, 0, { x: 0, z: 0 });
  // 门洞中心（N 面 z=0，x=1.5，高 1m 处）不应被任何墙体包含
  const inDoor = { x: 1.5, y: 1.0, z: 0.1 };
  assert.ok(!shell.walls.some((w) => containsPoint(w, inDoor)), '门洞被墙堵住');
  // 门旁（x=0.2）应被墙包含
  const beside = { x: 0.2, y: 1.0, z: 0.1 };
  assert.ok(shell.walls.some((w) => containsPoint(w, beside)), '门旁墙体缺失');
  // 门洞上方过梁存在（y=2.6 处）
  const lintel = { x: 1.5, y: 2.6, z: 0.1 };
  assert.ok(shell.walls.some((w) => containsPoint(w, lintel)), '过梁缺失');
});

test('worldIfaces 旋转后朝向随动', () => {
  const def = MODULES['corr-straight'];
  const r0 = worldIfaces(def, 0, { x: 0, z: 0 });
  const r1 = worldIfaces(def, 1, { x: 0, z: 0 });
  assert.deepEqual(r0[0].dir, { x: 0, z: -1 });
  assert.deepEqual(r1[0].dir, { x: 1, z: 0 });
});

test('接口类型决定门洞尺寸（边界尺寸）', () => {
  assert.equal(ifaceGeom(MODULES.hangar, MODULES.hangar.interfaces[0]).w, 3.2);
  assert.equal(ifaceGeom(MODULES.airlock, MODULES.airlock.interfaces[0]).w, 2.0);
});
