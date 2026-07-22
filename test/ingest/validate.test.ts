import * as assert from 'node:assert/strict';
import * as test from 'node:test';
import { IngestValidationError, validateIngest } from '../../demo/ingest/validate.ts';

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tagId: 'tag-watch',
    ts: 123456789,
    ranges: [
      { anchorId: 'phoneMain', distance: 1.23 },
      { anchorId: 'phoneSub', distance: 2.34 },
    ],
    accel: { x: 0, y: 0, z: 9.81 },
    source: 'ni',
    ...overrides,
  };
}

test.test('spec 03의 정상적인 2앵커 ingest를 허용한다', () => {
  const payload = validPayload();
  assert.equal(validateIngest(payload), payload);
});

test.test('파이프 검증을 위한 1앵커와 sim 소스를 허용한다', () => {
  assert.doesNotThrow(() => validateIngest(validPayload({
    ranges: [{ anchorId: 'phoneMain', distance: 1.23 }],
    source: 'sim',
  })));
});

test.test('객체가 아닌 payload와 필수 필드 누락을 거부한다', () => {
  assert.throws(() => validateIngest(null), IngestValidationError);

  assert.throws(
    () => validateIngest({}),
    (error: any) => error.issues.includes('tagId must be a non-empty string')
      && error.issues.includes('accel must be an object'),
  );
});

test.test('accel-only ingest: 빈/없는 ranges를 허용한다(NI 붙기 전 낙상 감지용)', () => {
  assert.doesNotThrow(() => validateIngest(validPayload({ ranges: [] })));

  const noRanges = validPayload();
  delete noRanges.ranges;
  assert.doesNotThrow(() => validateIngest(noRanges));
});

test.test('앵커가 3개 이상이면 거부한다', () => {
  assert.throws(
    () => validateIngest(validPayload({
      ranges: [
        { anchorId: 'phoneMain', distance: 1 },
        { anchorId: 'phoneSub', distance: 2 },
        { anchorId: 'phoneThird', distance: 3 },
      ],
    })),
    (error: any) => error.issues.includes('ranges must be an array of at most two anchors'),
  );
});

test.test('음수·무한 거리와 중복 앵커를 거부한다', () => {
  assert.throws(
    () => validateIngest(validPayload({
      ranges: [
        { anchorId: 'phoneMain', distance: -1 },
        { anchorId: 'phoneMain', distance: Infinity },
      ],
    })),
    (error: any) => error.issues.includes('ranges[0].distance must be a non-negative finite number')
      && error.issues.includes('ranges[1].distance must be a non-negative finite number')
      && error.issues.includes('ranges[1].anchorId must be unique'),
  );
});

test.test('잘못된 가속도와 source를 거부한다', () => {
  assert.throws(
    () => validateIngest(validPayload({
      accel: { x: 0, y: '0', z: NaN },
      source: 'phone',
    })),
    (error: any) => error.issues.includes('accel.y must be a finite number')
      && error.issues.includes('accel.z must be a finite number')
      && error.issues.includes('source must be one of: ni, sim'),
  );
});

test.test('0인 타임스탬프와 거리를 허용한다', () => {
  assert.doesNotThrow(() => validateIngest(validPayload({
    ts: 0,
    ranges: [{ anchorId: 'phoneMain', distance: 0 }],
  })));
});
