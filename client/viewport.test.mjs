import test from 'node:test';
import assert from 'node:assert/strict';
import { readViewport, writeViewport } from './viewport.mjs';

test('视口按稳定项目 ID 隔离，只保存位置与缩放', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  writeViewport('p1', { x: -20, y: 300, zoom: .75, slug: 'old', nodes: [] }, storage);
  writeViewport('p2', { x: 2, y: 3, zoom: 1.2 }, storage);
  assert.deepEqual(readViewport('p1', storage), { x: -20, y: 300, zoom: .75 });
  assert.deepEqual(readViewport('p2', storage), { x: 2, y: 3, zoom: 1.2 });
  assert.equal(readViewport('missing', storage), null);
  assert.deepEqual(Object.keys(JSON.parse(values.get('helix:viewport:p1'))).sort(), ['schemaVersion', 'x', 'y', 'zoom']);
});

test('存储拒绝、配额不足及无效缓存均安全降级', () => {
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.equal(readViewport('p', blocked), null);
  assert.doesNotThrow(() => writeViewport('p', { x: 1, y: 2, zoom: 1 }, blocked));
  for (const value of ['bad', '{}', '{"schemaVersion":1,"x":null,"y":0,"zoom":1}', '{"schemaVersion":1,"x":0,"y":0,"zoom":100}', '{"schemaVersion":1,"x":1000001,"y":0,"zoom":1}']) assert.equal(readViewport('p', { getItem: () => value }), null);
});

 test('拒绝写入越界观看位置', () => {
  const storage = { setItem() { assert.fail('越界视口不得写入'); } };
  for (const viewport of [{ x: 1e6 + 1, y: 0, zoom: 1 }, { x: 0, y: -1e6 - 1, zoom: 1 }, { x: 0, y: 0, zoom: 3 }]) writeViewport('p', viewport, storage);
});
