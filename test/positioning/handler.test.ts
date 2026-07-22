import * as assert from 'node:assert/strict';
import test from 'node:test';
import { IngestGenerator } from '../../harness/generator.ts';
import { createPositioningHandler } from '../../demo/positioning/handler.ts';

const OPTIONS = Object.freeze({
  mainAnchorId: 'phoneMain',
  subAnchorId: 'phoneSub',
  anchorDistance: 4,
  halfPlane: 'positive' as const,
});

function assertClose(actual: number, expected: number, tolerance = 1e-3): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test('B0 생성 거리에서 가상 태그의 원래 위치를 복원한다', () => {
  const generator = new IngestGenerator({
    anchorDistance: 4,
    start: { x: 1, y: 1 },
    velocity: { x: 0.4, y: 0.2 },
    rangeNoise: 0,
    random: () => 0.5,
    now: () => 123,
  });
  const positions: unknown[] = [];
  const handlePositioning = createPositioningHandler(OPTIONS, (position) => positions.push(position));

  const result = handlePositioning(generator.next(0.02))!;

  assertClose(result.pos.x, 1.008);
  assertClose(result.pos.y, 1.004);
  assert.deepEqual(positions, [result]);
});

test('한 앵커 ingest는 position을 방출하지 않는다', () => {
  const positions: unknown[] = [];
  const handlePositioning = createPositioningHandler(OPTIONS, (position) => positions.push(position));
  const result = handlePositioning({
    tagId: 'tag-watch',
    ts: 1,
    ranges: [{ anchorId: 'phoneMain', distance: 1 }],
    accel: { x: 0, y: 0, z: 9.81 },
    source: 'ni',
  });

  assert.equal(result, null);
  assert.deepEqual(positions, []);
});

test('onPosition은 함수여야 한다', () => {
  assert.throws(() => createPositioningHandler(OPTIONS, null as never), /onPosition must be a function/);
});
