'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { IngestGenerator } = require('./generator');

test('spec 03 ingest payload를 생성한다', () => {
  const generator = new IngestGenerator({
    anchorDistance: 4,
    start: { x: 1, y: 1 },
    velocity: { x: 0, y: 0 },
    rangeNoise: 0,
    random: () => 0.5,
    now: () => 123456789,
  });

  const payload = generator.next();

  assert.deepEqual(payload, {
    tagId: 'tag-watch',
    ts: 123456789,
    ranges: [
      { anchorId: 'phoneMain', distance: 1.414 },
      { anchorId: 'phoneSub', distance: 3.162 },
    ],
    accel: { x: 0, y: 0, z: 9.81 },
    source: 'sim',
  });
});

test('시간 간격에 따라 이동하고 경계에서 반사한다', () => {
  const generator = new IngestGenerator({
    start: { x: 3.7, y: 1 },
    velocity: { x: 1, y: 0 },
    rangeNoise: 0,
    random: () => 0.5,
    now: () => 1,
  });

  generator.next(0.2);

  assert.ok(Math.abs(generator.position.x - 3.7) < 1e-9);
  assert.equal(generator.velocity.x, -1);
});

test('잘못된 앵커 거리를 거부한다', () => {
  assert.throws(
    () => new IngestGenerator({ anchorDistance: 0 }),
    /anchorDistance must be a positive number/,
  );
});

test('낙상 주입 시 자유낙하, 충격, 정지 가속도를 순서대로 생성한다', () => {
  const generator = new IngestGenerator({
    velocity: { x: 0, y: 0 },
    rangeNoise: 0,
    sampleHz: 50,
    random: () => 0.5,
    now: () => 1,
  });

  generator.injectFall();
  const samples = Array.from({ length: 151 }, () => generator.next().accel);

  assert.deepEqual(samples.slice(0, 20), Array(20).fill({ x: 0.1, y: 0.1, z: 0.2 }));
  assert.deepEqual(samples.slice(20, 30), Array(10).fill({ x: 4, y: 3, z: 32 }));
  assert.deepEqual(samples.slice(30, 150), Array(120).fill({ x: 0.03, y: 0.02, z: 9.81 }));
  assert.deepEqual(samples[150], { x: 0, y: 0, z: 9.81 });
});
