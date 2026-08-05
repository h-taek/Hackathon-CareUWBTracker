// 익명화 검사(spec system 03 §7.1).
//
// **키 목록으로 검사한다.** "tagId가 없다"를 하나씩 단언하면 경보 스키마에 필드가 늘 때
// 검사가 따라가지 못한다. 결과 객체에 허용된 키 말고는 아무것도 없다고 못 박는다.

import * as assert from 'node:assert/strict';
import test from 'node:test';

import { toSample, MIN_SAMPLES } from '../../server/events/export/sample.ts';
import type { EventRecord } from '../../server/events/recorder.ts';

const T0 = 1_700_000_000_000;

const ALLOWED = ['dt', 'ax', 'ay', 'az', 'label', 'peakAccel', 'freefall', 'aiScore', 'hz'];

function record(fields: Partial<EventRecord> = {}): EventRecord {
  const accel = Array.from({ length: 20 }, (_, i) => ({
    ts: T0 + i * 20,
    x: i * 0.1,
    y: i * 0.2,
    z: 9.8 + i,
  }));
  return {
    eventId: 'evt-1',
    tagId: 'tag-101',
    ts: T0 + 200,
    alert: {
      eventId: 'evt-1',
      tagId: 'tag-101',
      ts: T0 + 200,
      type: 'fall_detected',
      peakAccel: 3.8,
      freefall: true,
      aiScore: 0.91,
      floor: '2F',
      zone: '화장실(여)',
      pos: { x: 3.1, y: 4.2 },
    },
    track: [{ ts: T0, x: 1, y: 2 }],
    accel,
    attachments: [],
    outcome: 'confirmed',
    resolvedAt: T0 + 1000,
    resolvedBy: 'op-1',
    ...fields,
  };
}

test('반출물에는 허용된 키 말고 아무것도 없다', () => {
  const result = toSample(record());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  for (const key of Object.keys(result.sample)) {
    assert.ok(ALLOWED.includes(key), `반출물에 ${key}가 들어 있다`);
  }
  // 직렬화한 문자열에도 식별 요소가 없어야 한다 — 중첩 객체로 숨어 들어가는 경로까지 막는다.
  const json = JSON.stringify(result.sample);
  for (const leak of ['tag-101', 'evt-1', '화장실', '2F', String(T0)]) {
    assert.ok(!json.includes(leak), `반출물에 ${leak}가 남아 있다`);
  }
});

test('절대 시각이 창 첫 표본 기준 상대 ms가 된다', () => {
  const result = toSample(record());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.sample.dt[0], 0);
  assert.deepEqual(result.sample.dt.slice(0, 3), [0, 20, 40]);
  assert.equal(result.sample.dt.length, result.sample.ax.length);
  assert.equal(result.sample.hz, 50);
});

test('라벨은 관제사 판정에서만 온다', () => {
  const confirmed = toSample(record({ outcome: 'confirmed' }));
  assert.equal(confirmed.ok && confirmed.sample.label, 1);

  const falseAlarm = toSample(record({ outcome: 'false_alarm' }));
  assert.equal(falseAlarm.ok && falseAlarm.sample.label, 0);
});

test('판정이 없으면 표본이 아니다 — 감지기 판정을 라벨로 쓰지 않는다', () => {
  for (const outcome of ['detected', undefined] as const) {
    const result = toSample(record({ outcome }));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'unjudged');
  }
});

test('창이 안 찬 레코드는 뽑지 않는다', () => {
  const short = Array.from({ length: MIN_SAMPLES - 1 }, (_, i) => ({
    ts: T0 + i * 20, x: 0, y: 0, z: 9.8,
  }));
  const result = toSample(record({ accel: short }));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'too-short');
});

test('감지기 메타는 값을 확인하고 넣는다 — alert 스키마를 믿지 않는다', () => {
  const result = toSample(record({
    alert: { peakAccel: '3.8', freefall: 'yes', aiScore: Number.NaN, tagId: 'tag-101' },
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.sample.peakAccel, undefined, '문자열은 안 넣는다');
  assert.equal(result.sample.freefall, undefined, 'boolean이 아니면 안 넣는다');
  assert.equal(result.sample.aiScore, undefined, 'NaN은 안 넣는다');
});

test('좌표는 읽지도 않는다 — track이 있어도 반출물에 자리가 없다', () => {
  const result = toSample(record({ track: Array.from({ length: 200 }, () => ({ ts: T0, x: 9, y: 9 })) }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(!Object.keys(result.sample).includes('track'));
  assert.ok(!JSON.stringify(result.sample).includes('"x"'));
});
