import test from 'node:test';
import assert from 'node:assert/strict';
import { rotVec, rotSize, localToWorld, overlaps, aabbDistance, aabbOf } from '../kernel/geom.js';

test('rotVec 四次旋转回到原向', () => {
  const v = { x: 1, z: 0 };
  let r = v;
  for (let i = 0; i < 4; i++) r = rotVec(r, 1);
  assert.deepEqual(r, { x: 1, y: 0, z: 0 });
});

test('rotSize 奇次旋转交换 x/z', () => {
  assert.deepEqual(rotSize({ x: 3, y: 3, z: 6 }, 1), { x: 6, y: 3, z: 3 });
  assert.deepEqual(rotSize({ x: 3, y: 3, z: 6 }, 2), { x: 3, y: 3, z: 6 });
});

test('localToWorld 旋转后角点集与包围盒一致', () => {
  const size = { x: 3, y: 3, z: 6 };
  for (let rot = 0; rot < 4; rot++) {
    const box = aabbOf(size, rot, { x: 10, z: 20 });
    const corners = [
      localToWorld({ x: 0, y: 0, z: 0 }, rot, { x: 10, z: 20 }, size),
      localToWorld({ x: size.x, y: 0, z: size.z }, rot, { x: 10, z: 20 }, size),
    ];
    const minX = Math.min(...corners.map((c) => c.x));
    const maxX = Math.max(...corners.map((c) => c.x));
    const minZ = Math.min(...corners.map((c) => c.z));
    const maxZ = Math.max(...corners.map((c) => c.z));
    assert.ok(Math.abs(minX - box.min.x) < 1e-9 && Math.abs(maxX - box.max.x) < 1e-9);
    assert.ok(Math.abs(minZ - box.min.z) < 1e-9 && Math.abs(maxZ - box.max.z) < 1e-9);
  }
});

test('AABB 贴面不算重叠，穿插算重叠', () => {
  const a = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 4 } };
  const touch = { min: { x: 4, y: 0, z: 0 }, max: { x: 8, y: 3, z: 4 } };
  const into = { min: { x: 3.9, y: 0, z: 0 }, max: { x: 8, y: 3, z: 4 } };
  assert.equal(overlaps(a, touch), false);
  assert.equal(overlaps(a, into), true);
});

test('aabbDistance 间距计算', () => {
  const a = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } };
  const b = { min: { x: 5, y: 0, z: 0 }, max: { x: 7, y: 2, z: 2 } };
  assert.equal(aabbDistance(a, b), 3);
});
