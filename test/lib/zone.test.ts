import test from 'node:test';
import * as assert from 'node:assert';
import { zoneAt, type ZoneMap } from '../../server/lib/zone.ts';

const map: ZoneMap = { zones: [
  { id: 'z_hall', label: '복도', rect: [0.5, 4.5, 19.0, 1.8] },
  { id: 'z_stair', label: '계단 옆', rect: [0.5, 0.5, 4.0, 3.5] },
] };

test('점이 든 zone의 label을 반환한다', () => {
  assert.strictEqual(zoneAt(map, 2, 2), '계단 옆');
  assert.strictEqual(zoneAt(map, 10, 5), '복도');
});

test('어느 zone에도 없으면 미지정', () => {
  assert.strictEqual(zoneAt(map, 19, 11), '미지정');
});
