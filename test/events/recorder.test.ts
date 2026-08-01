import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEventRecorder,
  recorderOptionsFromEnv,
  RECORDER_DEFAULTS,
  type EventRecord,
} from '../../server/events/recorder.ts';

/** 타이머를 손으로 돌린다 — 벽시계 폴백이 언제 도는지가 이 모듈의 핵심 동작이라 실제로 기다릴 수 없다. */
function fakeTimers() {
  const queued: { id: number; run: () => void; delayMs: number }[] = [];
  let nextId = 1;
  return {
    schedule(run: () => void, delayMs: number): unknown {
      const id = nextId++;
      queued.push({ id, run, delayMs });
      return id;
    },
    cancelSchedule(timer: unknown): void {
      const index = queued.findIndex((entry) => entry.id === timer);
      if (index >= 0) queued.splice(index, 1);
    },
    /** 예약된 것들을 전부 실행한다. */
    fire(): void {
      for (const entry of [...queued]) {
        this.cancelSchedule(entry.id);
        entry.run();
      }
    },
    get pending(): number { return queued.length; },
    get delays(): number[] { return queued.map((entry) => entry.delayMs); },
  };
}

function setup(overrides: { preWindowMs?: number; postWindowMs?: number; flushGraceMs?: number } = {}) {
  const records: EventRecord[] = [];
  const errors: unknown[] = [];
  const timers = fakeTimers();
  const recorder = createEventRecorder({
    preWindowMs: 1000,
    postWindowMs: 1000,
    flushGraceMs: 200,
    ...overrides,
    onRecord: (record) => records.push(record),
    onError: (error) => errors.push(error),
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule.bind(timers),
  });
  return { recorder, records, errors, timers };
}

const frame = (tagId: string, ts: number, accel = { x: 0, y: 0, z: 9.8 }) => ({
  tagId, ts, source: 'ni', accel,
});
const at = (x: number, y: number) => ({ pos: { x, y, z: 0 } });
const alert = (eventId: string, tagId: string, ts: number) => ({
  eventId, tagId, ts, type: 'fall_detected', peakAccel: 3.2, zone: '복도',
});

test('경보 시각 전후 창 안의 표본만 담고, 창 밖은 버린다', () => {
  const { recorder, records } = setup({ preWindowMs: 1000, postWindowMs: 1000 });

  // 5000이 사고 시각. 3900은 창 밖(pre 경계 4000), 4000·5000·6000은 안, 6100은 밖.
  for (const ts of [3900, 4000, 5000, 6000, 6100]) {
    recorder.observe(frame('tag-a', ts), at(ts / 1000, 0));
    if (ts === 5000) recorder.record(alert('evt-1', 'tag-a', 5000));
  }

  assert.equal(records.length, 1);
  assert.deepEqual(records[0].accel.map((s) => s.ts), [4000, 5000, 6000]);
  assert.deepEqual(records[0].track.map((s) => s.ts), [4000, 5000, 6000]);
});

test('post 창을 채우는 프레임이 도착하면 그때 기록이 닫힌다', () => {
  const { recorder, records, timers } = setup({ postWindowMs: 1000 });

  recorder.observe(frame('tag-a', 5000), at(1, 1));
  recorder.record(alert('evt-1', 'tag-a', 5000));
  assert.equal(records.length, 0, '경보 직후에는 아직 안 닫힌다');
  assert.equal(recorder.pendingCount(), 1);

  recorder.observe(frame('tag-a', 5999), at(1, 1));
  assert.equal(records.length, 0, '1ms 모자라면 계속 기다린다');

  recorder.observe(frame('tag-a', 6000), at(1, 1));
  assert.equal(records.length, 1);
  assert.equal(recorder.pendingCount(), 0);
  assert.equal(timers.pending, 0, '데이터로 닫혔으면 폴백 타이머는 취소된다');
});

test('프레임이 멎어도 벽시계 폴백이 기록을 닫는다', () => {
  // 클립 주입은 몇 초짜리라 재생이 끝나면 그 태그의 ingest가 아예 안 온다.
  const { recorder, records, timers } = setup({ postWindowMs: 1000, flushGraceMs: 200 });

  recorder.observe(frame('tag-a', 5000), at(2, 3));
  recorder.record(alert('evt-1', 'tag-a', 5000));
  assert.deepEqual(timers.delays, [1200], 'post + grace 뒤에 예약된다');

  timers.fire();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].accel.map((s) => s.ts), [5000], '있는 만큼만 담아 닫는다');
});

test('좌표가 없는 accel-only 프레임은 궤적에 남기지 않는다', () => {
  // 삼각측량이 보류된 구간이다. 없는 위치를 지어내면 R-5 화면에서 유령 동선이 된다.
  const { recorder, records } = setup();

  recorder.observe(frame('tag-a', 4500), null);
  recorder.observe(frame('tag-a', 5000), at(1, 2));
  recorder.record(alert('evt-1', 'tag-a', 5000));
  recorder.flushAll();

  assert.deepEqual(records[0].accel.map((s) => s.ts), [4500, 5000]);
  assert.deepEqual(records[0].track, [{ ts: 5000, x: 1, y: 2 }]);
});

test('도착 순서가 뒤집혀도 기록은 시각순으로 정렬된다', () => {
  // 프레임당 POST 1건이라 전송이 겹치면 도착 순서가 실제로 뒤집힌다.
  const { recorder, records } = setup();

  recorder.observe(frame('tag-a', 5000), at(1, 0));
  recorder.observe(frame('tag-a', 4800), at(2, 0));
  recorder.observe(frame('tag-a', 4900), at(3, 0));
  recorder.record(alert('evt-1', 'tag-a', 5000));
  recorder.flushAll();

  assert.deepEqual(records[0].track.map((s) => s.ts), [4800, 4900, 5000]);
  assert.deepEqual(records[0].accel.map((s) => s.ts), [4800, 4900, 5000]);
});

test('늦게 온 과거 프레임이 post 창 판정을 되돌리지 않는다', () => {
  const { recorder, records } = setup({ postWindowMs: 1000 });

  recorder.observe(frame('tag-a', 5000), at(1, 0));
  recorder.record(alert('evt-1', 'tag-a', 5000));
  recorder.observe(frame('tag-a', 4000), at(1, 0)); // 한참 늦게 도착한 옛 프레임
  assert.equal(records.length, 0);

  recorder.observe(frame('tag-a', 6000), at(1, 0));
  assert.equal(records.length, 1);
});

test('경보 레코드는 원본 그대로 싣되, 뒤에 바뀌어도 흔들리지 않는다', () => {
  const { recorder, records } = setup();
  const event = alert('evt-1', 'tag-a', 5000);

  recorder.observe(frame('tag-a', 5000), at(1, 2));
  recorder.record(event);
  event.zone = '나중에 덮어쓴 값';
  recorder.flushAll();

  assert.equal(records[0].alert.zone, '복도');
  assert.equal(records[0].alert.peakAccel, 3.2);
  assert.deepEqual(records[0].attachments, [], 'R-2~R-4가 채울 자리는 비워 둔다');
});

test('같은 eventId를 두 번 등록해도 기록은 하나만 나간다', () => {
  const { recorder, records } = setup();

  recorder.observe(frame('tag-a', 5000), at(1, 2));
  assert.equal(recorder.record(alert('evt-1', 'tag-a', 5000)), true);
  assert.equal(recorder.record(alert('evt-1', 'tag-a', 5000)), false);
  recorder.flushAll();

  assert.equal(records.length, 1);
});

test('eventId·tagId·ts가 없는 경보는 등록하지 않는다', () => {
  const { recorder } = setup();

  assert.equal(recorder.record({ tagId: 'tag-a', ts: 1 }), false);
  assert.equal(recorder.record({ eventId: 'evt-1', ts: 1 }), false);
  assert.equal(recorder.record({ eventId: 'evt-1', tagId: 'tag-a' }), false);
  assert.equal(recorder.record({ eventId: '', tagId: 'tag-a', ts: 1 }), false);
  assert.equal(recorder.pendingCount(), 0);
});

test('태그별로 버퍼가 섞이지 않는다', () => {
  const { recorder, records } = setup();

  recorder.observe(frame('tag-a', 5000), at(1, 1));
  recorder.observe(frame('tag-b', 5000), at(9, 9));
  recorder.record(alert('evt-1', 'tag-a', 5000));
  recorder.flushAll();

  assert.deepEqual(records[0].track, [{ ts: 5000, x: 1, y: 1 }]);
});

test('reset은 대기 중인 기록을 먼저 닫고 버퍼를 비운다', () => {
  // 클립을 다시 주입할 때 부른다. 안 비우면 앞 클립 파형이 다음 사고의 '직전'으로 붙는다.
  const { recorder, records } = setup();

  recorder.observe(frame('tag-a', 5000), at(1, 1));
  recorder.record(alert('evt-1', 'tag-a', 5000));
  recorder.reset('tag-a');

  assert.equal(records.length, 1, '있는 만큼으로 닫아서 기록을 잃지 않는다');
  assert.equal(recorder.pendingCount(), 0);
  assert.deepEqual(recorder.bufferedCount('tag-a'), { track: 0, accel: 0 });
});

test('링버퍼는 pre+post 밖의 표본을 버려 무한히 자라지 않는다', () => {
  const { recorder } = setup({ preWindowMs: 1000, postWindowMs: 1000 });

  // 100ms 간격 600프레임 = 60초. 남아야 하는 건 마지막 2초(=pre+post)뿐이다.
  for (let i = 0; i < 600; i += 1) recorder.observe(frame('tag-a', i * 100), at(0, 0));

  const counted = recorder.bufferedCount('tag-a');
  assert.ok(counted.accel <= 21, `가속도 표본이 ${counted.accel}개 남았다`);
  assert.ok(counted.track <= 21, `궤적 표본이 ${counted.track}개 남았다`);
});

test('보관 구간을 넘겨 오래 지난 뒤에도 pre 창은 온전히 남아 있다', () => {
  const { recorder, records } = setup({ preWindowMs: 1000, postWindowMs: 1000 });

  for (let i = 0; i <= 100; i += 1) recorder.observe(frame('tag-a', i * 100), at(0, 0));
  // 사고 시각을 마지막 프레임(10000)으로 잡으면 pre 창 9000~10000이 통째로 필요하다.
  recorder.record(alert('evt-1', 'tag-a', 10000));
  recorder.flushAll();

  assert.deepEqual(records[0].accel[0].ts, 9000);
  assert.equal(records[0].accel.length, 11);
});

test('저장이 실패해도 던지지 않고 onError로 넘긴다', () => {
  // 타이머 안에서도 불린다. 여기서 안 막으면 디스크가 찼을 때 서버가 통째로 죽는다.
  const errors: unknown[] = [];
  const timers = fakeTimers();
  const recorder = createEventRecorder({
    postWindowMs: 1000,
    onRecord: () => { throw new Error('디스크 없음'); },
    onError: (error) => errors.push(error),
    schedule: timers.schedule,
    cancelSchedule: timers.cancelSchedule.bind(timers),
  });

  recorder.observe(frame('tag-a', 5000), at(1, 1));
  recorder.record(alert('evt-1', 'tag-a', 5000));
  assert.doesNotThrow(() => timers.fire());
  assert.equal(errors.length, 1);
  assert.equal(recorder.pendingCount(), 0, '실패해도 대기 목록에서는 빠진다');
});

test('음수 창 길이는 생성 시점에 거부한다', () => {
  assert.throws(
    () => createEventRecorder({ preWindowMs: -1, onRecord: () => {} }),
    /preWindowMs/,
  );
});

test('환경변수가 없으면 기본 창(전후 10초)을 쓴다', () => {
  assert.deepEqual(recorderOptionsFromEnv({}), {
    preWindowMs: RECORDER_DEFAULTS.preWindowMs,
    postWindowMs: RECORDER_DEFAULTS.postWindowMs,
  });
  assert.equal(RECORDER_DEFAULTS.preWindowMs, 10_000);
  assert.equal(RECORDER_DEFAULTS.postWindowMs, 10_000);
});

test('환경변수로 창 길이를 바꾼다', () => {
  assert.deepEqual(
    recorderOptionsFromEnv({ EVENT_PRE_MS: '3000', EVENT_POST_MS: '4000' }),
    { preWindowMs: 3000, postWindowMs: 4000 },
  );
  // 못 읽는 값은 조용히 기본값으로 — 오타 하나로 서버가 안 뜨는 것보다 낫다.
  assert.deepEqual(
    recorderOptionsFromEnv({ EVENT_PRE_MS: '삼초', EVENT_POST_MS: '-5' }),
    { preWindowMs: RECORDER_DEFAULTS.preWindowMs, postWindowMs: RECORDER_DEFAULTS.postWindowMs },
  );
});
