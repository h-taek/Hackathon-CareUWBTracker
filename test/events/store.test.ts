import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createEventStore, isValidEventId, summarize } from '../../server/events/store.ts';
import type { EventRecord } from '../../server/events/recorder.ts';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-'));
  return { store: createEventStore(path.join(dir, 'events')), root: dir };
}

function record(eventId: string, ts: number, tagId = 'tag-a'): EventRecord {
  return {
    eventId,
    tagId,
    ts,
    alert: { eventId, tagId, ts, type: 'fall_detected', peakAccel: 3.2, zone: '복도', aiScore: 0.9 },
    track: [{ ts, x: 1, y: 2 }],
    accel: [{ ts, x: 0, y: 0, z: 9.8 }],
    attachments: [],
  };
}

test('저장한 레코드를 그대로 다시 읽는다', () => {
  const { store } = tempStore();
  const saved = record('evt-1', 5000);
  store.save(saved);

  assert.deepEqual(store.read('evt-1'), saved);
});

test('폴더가 없어도 첫 저장에서 만든다', () => {
  const { store } = tempStore();
  assert.equal(fs.existsSync(store.dir), false);

  store.save(record('evt-1', 5000));
  assert.equal(fs.existsSync(path.join(store.dir, 'evt-1.json')), true);
});

test('이벤트가 없으면 목록은 빈 배열이다 (폴더가 없는 게 정상)', () => {
  const { store } = tempStore();
  assert.deepEqual(store.list(), []);
});

test('없는 이벤트는 null이다', () => {
  const { store } = tempStore();
  store.save(record('evt-1', 5000));
  assert.equal(store.read('evt-2'), null);
});

test('목록은 사고 시각 최신순이고 궤적·가속도 배열 대신 개수를 준다', () => {
  const { store } = tempStore();
  store.save(record('evt-1', 1000));
  store.save(record('evt-2', 3000));
  store.save(record('evt-3', 2000));

  const list = store.list();
  assert.deepEqual(list.map((s) => s.eventId), ['evt-2', 'evt-3', 'evt-1']);
  assert.equal(list[0].trackCount, 1);
  assert.equal(list[0].accelCount, 1);
  assert.equal(list[0].attachmentCount, 0);
  assert.equal('track' in list[0], false);
  assert.equal('accel' in list[0], false);
});

test('목록 요약은 경보의 화면용 필드를 끌어올린다', () => {
  const summary = summarize(record('evt-1', 5000));
  assert.equal(summary.type, 'fall_detected');
  assert.equal(summary.peakAccel, 3.2);
  assert.equal(summary.zone, '복도');
  assert.equal(summary.aiScore, 0.9);
});

test('limit은 최신 것부터 자른다', () => {
  const { store } = tempStore();
  for (let i = 1; i <= 5; i += 1) store.save(record(`evt-${i}`, i * 1000));

  assert.deepEqual(store.list(2).map((s) => s.eventId), ['evt-5', 'evt-4']);
});

test('깨진 파일 하나가 목록 전체를 못 쓰게 만들지 않는다', () => {
  const { store } = tempStore();
  store.save(record('evt-1', 1000));
  fs.writeFileSync(path.join(store.dir, 'evt-broken.json'), '{ 잘린 json', 'utf8');

  assert.deepEqual(store.list().map((s) => s.eventId), ['evt-1']);
});

test('json이 아닌 파일은 목록에서 무시한다', () => {
  const { store } = tempStore();
  store.save(record('evt-1', 1000));
  fs.writeFileSync(path.join(store.dir, 'README.txt'), '메모', 'utf8');

  assert.equal(store.list().length, 1);
});

test('저장은 임시 파일을 거쳐 원자적으로 바꾼다 — .tmp가 남지 않는다', () => {
  const { store } = tempStore();
  store.save(record('evt-1', 1000));

  assert.deepEqual(fs.readdirSync(store.dir), ['evt-1.json']);
});

test('eventId가 파일 경로를 벗어나면 막는다', () => {
  // eventId가 그대로 파일 이름이 된다. 조회 경로로 들어온 값이라 저장소 밖을 가리킬 수 있다.
  assert.equal(isValidEventId('evt-tag-a-1000-1'), true);
  assert.equal(isValidEventId('../../etc/passwd'), false);
  assert.equal(isValidEventId('evt/../secret'), false);
  assert.equal(isValidEventId('evt with space'), false);
  assert.equal(isValidEventId(''), false);
  assert.equal(isValidEventId('a'.repeat(129)), false);
  assert.equal(isValidEventId(null), false);
});

test('경로를 벗어나는 eventId는 저장도 조회도 안 된다', () => {
  const { store, root } = tempStore();
  assert.throws(() => store.save(record('../escaped', 1000)), /eventId/);
  assert.equal(store.read('../escaped'), null);
  assert.equal(fs.existsSync(path.join(root, 'escaped.json')), false);
});
