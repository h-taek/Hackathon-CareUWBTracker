import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createEventStore } from '../../server/events/store.ts';
import { createRetention } from '../../server/events/retention.ts';
import { createAuditLog, type AuditEntry } from '../../server/lib/audit.ts';
import type { EventRecord } from '../../server/events/recorder.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UNDO = 24 * HOUR;
const INCIDENT = 1095 * DAY;

const T0 = 1_700_000_000_000;

/**
 * 감지 이벤트와 확인 사건은 서로 다른 폴더에 산다(spec operation 02 §2).
 * 이 벤치도 그 구조를 그대로 만든다 — 하나로 합치면 이 파일의 검사가 의미를 잃는다.
 */
function bench(overrides: Partial<Parameters<typeof createRetention>[0]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
  const store = createEventStore(path.join(root, 'events'));
  const incidents = createEventStore(path.join(root, 'incidents'));
  const entries: AuditEntry[] = [];
  const audit = createAuditLog(path.join(root, 'audit'), { onEntry: (e) => entries.push(e) });
  const retention = createRetention({
    store,
    incidents,
    audit,
    undoWindowMs: UNDO,
    incidentRetentionMs: INCIDENT,
    facilityDir: path.join(root, 'facility'),
    onLog: () => {},
    ...overrides,
  });
  return { root, store, incidents, retention, entries, facility: path.join(root, 'facility') };
}

function record(eventId: string, ts: number, fields: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId,
    tagId: 'tag-101',
    ts,
    alert: { eventId, tagId: 'tag-101', ts, type: 'fall_detected', zone: '북측 복도' },
    track: [{ ts, x: 1, y: 2 }, { ts: ts + 20, x: 1.1, y: 2.1 }],
    accel: [{ ts, x: 0, y: 0, z: 9.8 }],
    attachments: [],
    ...fields,
  };
}

test('감지 이벤트는 판정 여부와 무관하게 24시간이면 사라진다', () => {
  const { store, retention, entries } = bench();
  store.save(record('evt-1', T0));                                             // 판정 전
  store.save(record('evt-2', T0, { outcome: 'confirmed', resolvedAt: T0 }));   // 낙상
  store.save(record('evt-3', T0, { outcome: 'false_alarm', resolvedAt: T0 })); // 오보

  assert.deepEqual(retention.sweep(T0 + 23 * HOUR), [], '24시간 안에는 안 지운다');

  const actions = retention.sweep(T0 + UNDO + 1);
  assert.deepEqual(actions.map((a) => a.action), ['delete', 'delete', 'delete']);
  assert.equal(store.list(99).length, 0);
  assert.equal(entries.filter((e) => e.detail.includes('감지 이벤트 보관기간 경과')).length, 3);
});

test('이벤트를 지워도 사건은 남는다 — 사본이라 원본에 매이지 않는다', () => {
  const { store, incidents, retention } = bench();
  store.save(record('evt-1', T0, { outcome: 'confirmed', resolvedAt: T0 }));
  incidents.save(record('evt-1', T0, { outcome: 'confirmed', resolvedAt: T0 }));

  retention.sweep(T0 + UNDO + 1);

  assert.equal(store.read('evt-1'), null, '로그는 사라졌다');
  assert.equal(incidents.read('evt-1')?.outcome, 'confirmed', '사건은 그대로다');
});

test('감지 이벤트를 지우기 직전에 학습 표본을 뽑는다', () => {
  const collected: EventRecord[] = [];
  const { store, retention } = bench({
    exporter: { collect: (r: EventRecord) => collected.push(r), flushSoon: () => {} },
  });
  store.save(record('evt-1', T0, { outcome: 'confirmed', resolvedAt: T0 }));
  store.save(record('evt-2', T0, { outcome: 'false_alarm', resolvedAt: T0 }));

  retention.sweep(T0 + UNDO + 1);
  // 목록 순서는 파일 시각이 정해 뒤집힐 수 있다. 무엇이 뽑혔는지만 본다.
  assert.deepEqual(collected.map((r) => r.eventId).sort(), ['evt-1', 'evt-2']);
  assert.deepEqual(collected.map((r) => r.outcome).sort(), ['confirmed', 'false_alarm']);
  assert.equal(store.list(99).length, 0, '뽑고 나서 지운다');
});

test('확인 사건 삭제 경로에서는 안 뽑는다 — 24시간 시점에 이미 반출됐다', () => {
  const collected: EventRecord[] = [];
  const { incidents, retention } = bench({
    exporter: { collect: (r: EventRecord) => collected.push(r), flushSoon: () => {} },
  });
  incidents.save(record('evt-1', T0, { outcome: 'confirmed', resolvedAt: T0 }));

  retention.sweep(T0 + INCIDENT + 1);
  assert.deepEqual(collected, [], '같은 표본이 두 번 나가지 않는다');
});

test('반출이 던져도 파기는 진행한다', () => {
  const { store, retention } = bench({
    exporter: {
      collect: () => { throw new Error('큐를 못 쓴다'); },
      flushSoon: () => {},
    },
  });
  store.save(record('evt-1', T0, { outcome: 'confirmed', resolvedAt: T0 }));

  // 전송 장애가 법정 파기 의무를 막으면 안 된다.
  const actions = retention.sweep(T0 + UNDO + 1);
  assert.deepEqual(actions.map((a) => a.action), ['delete']);
  assert.equal(store.read('evt-1'), null);
});

test('dry-run에서는 뽑지도 보내지도 않는다', () => {
  const collected: EventRecord[] = [];
  let flushed = 0;
  const { store, retention } = bench({
    dryRun: true,
    exporter: { collect: (r: EventRecord) => collected.push(r), flushSoon: () => { flushed += 1; } },
  });
  store.save(record('evt-1', T0, { outcome: 'confirmed', resolvedAt: T0 }));

  retention.sweep(T0 + UNDO + 1);
  assert.deepEqual(collected, []);
  assert.equal(flushed, 0);
  assert.ok(store.read('evt-1'), '지우지도 않는다');
});

test('확인 사건은 3년까지 남고 그 뒤에 파기된다', () => {
  const { incidents, retention } = bench();
  incidents.save(record('evt-1', T0, { outcome: 'confirmed', resolvedAt: T0 }));

  assert.deepEqual(retention.sweep(T0 + INCIDENT - 1), [], '3년 안에는 안 지운다');
  assert.deepEqual(retention.sweep(T0 + INCIDENT + 1).map((a) => a.action), ['delete']);
  assert.equal(incidents.read('evt-1'), null);
});

test('3년이 지난 사건의 영상과 3D는 시설 자산으로 넘어간다', () => {
  const { incidents, retention, facility, entries } = bench();
  incidents.save(record('evt-1', T0, {
    outcome: 'confirmed',
    resolvedAt: T0,
    attachments: [
      { attachmentId: 'att-1', eventId: 'evt-1', kind: 'video', path: 'att-1.mov' },
      { attachmentId: 'att-2', eventId: 'evt-1', kind: 'splat', path: 'att-2.ply', sourceAttachmentId: 'att-1' },
    ],
  }));
  const folder = incidents.eventDir('evt-1');
  fs.writeFileSync(path.join(folder, 'att-1.mov'), 'video bytes');
  fs.writeFileSync(path.join(folder, 'att-2.ply'), 'splat bytes');

  const actions = retention.sweep(T0 + INCIDENT + 1);

  assert.deepEqual(actions.map((a) => a.action), ['facility-transfer', 'facility-transfer', 'delete']);
  const moved = fs.readdirSync(path.join(facility, '북측-복도')).sort();
  assert.deepEqual(moved, ['북측-복도-01.mov', '북측-복도-01.ply'],
    '이름에 eventId도 촬영 시각도 안 남는다');
  assert.equal(fs.existsSync(folder), false);
  assert.equal(entries.filter((e) => e.detail.includes('사건 연결 해제')).length, 2);
});

test('재구성이 끝난 중간물은 지우되 산출물·로그·카메라는 남긴다', () => {
  const { incidents, retention } = bench();
  // 산출물은 이벤트 폴더 루트로 옮겨지지 않고 작업 폴더 안 그 자리가 첨부로 등록된다.
  incidents.save(record('evt-1', T0, {
    outcome: 'confirmed',
    resolvedAt: T0,
    attachments: [
      { attachmentId: 'att-1', eventId: 'evt-1', kind: 'video', path: 'att-1.mov', recon: { status: 'done' } },
      { attachmentId: 'att-2', eventId: 'evt-1', kind: 'splat', path: 'recon/att-1/scene.ply', sourceAttachmentId: 'att-1' },
    ],
  }));
  const work = path.join(incidents.eventDir('evt-1'), 'recon', 'att-1');
  fs.mkdirSync(path.join(work, 'frames'), { recursive: true });
  fs.mkdirSync(path.join(work, 'project'), { recursive: true });
  fs.writeFileSync(path.join(work, 'frames', '001.jpg'), 'x'.repeat(100));
  fs.writeFileSync(path.join(work, 'database.db'), 'x'.repeat(500));
  fs.writeFileSync(path.join(work, 'scene.ply'), 'x'.repeat(300));
  fs.writeFileSync(path.join(work, 'recon.log'), 'log');
  fs.writeFileSync(path.join(work, 'cameras.json'), '{}');

  const actions = retention.purgeWorkdir('evt-1');

  assert.deepEqual(actions.map((a) => a.action), ['purge-workdir']);
  assert.equal(actions[0].bytes, 600, 'frames 100 + database.db 500. 산출물은 안 센다');
  assert.deepEqual(fs.readdirSync(work).sort(), ['cameras.json', 'recon.log', 'scene.ply']);
});

test('레코드가 첨부로 가리키는 것은 무엇이든 안 지운다', () => {
  // 지울 목록에 이름을 잘못 올려도 이 가드가 산출물을 지킨다.
  const { incidents, retention } = bench();
  incidents.save(record('evt-1', T0, {
    outcome: 'confirmed',
    resolvedAt: T0,
    attachments: [
      { attachmentId: 'att-1', eventId: 'evt-1', kind: 'video', path: 'a.mov', recon: { status: 'done' } },
      { attachmentId: 'att-2', eventId: 'evt-1', kind: 'splat', path: 'recon/att-1/project/out.ply' },
    ],
  }));
  const work = path.join(incidents.eventDir('evt-1'), 'recon', 'att-1');
  fs.mkdirSync(path.join(work, 'project'), { recursive: true });
  fs.writeFileSync(path.join(work, 'project', 'out.ply'), 'x'.repeat(700));
  fs.writeFileSync(path.join(work, 'database.db'), 'x'.repeat(500));

  const actions = retention.purgeWorkdir('evt-1');

  assert.equal(actions[0].bytes, 500, 'database.db만 지운다');
  assert.equal(fs.existsSync(path.join(work, 'project', 'out.ply')), true, '첨부를 품은 폴더는 통째로 지킨다');
});

/** 실패·중지된 재구성 한 건과 그 작업 폴더. `at`이 끝난 시각이다. */
function withDeadRun(status: 'failed' | 'cancelled', at: number, now: number) {
  const { incidents, retention, entries } = bench({ now: () => now });
  incidents.save(record('evt-1', T0, {
    outcome: 'confirmed',
    resolvedAt: T0,
    attachments: [{
      attachmentId: 'att-1',
      eventId: 'evt-1',
      kind: 'video',
      path: 'a.mov',
      recon: { status, finishedAt: at },
    }],
  }));
  const work = path.join(incidents.eventDir('evt-1'), 'recon', 'att-1');
  fs.mkdirSync(path.join(work, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(work, 'frames', '001.jpg'), 'x'.repeat(100));
  fs.writeFileSync(path.join(work, 'database.db'), 'x'.repeat(500));
  fs.writeFileSync(path.join(work, 'recon.log'), '실패 원인이 여기 있다');
  return { incidents, retention, entries, work };
}

test('실패한 재구성은 유예 안에서는 건드리지 않는다 — 원인 추적이 아직 목적이다', () => {
  const { retention, work } = withDeadRun('failed', T0, T0 + 23 * HOUR);

  assert.deepEqual(retention.purgeWorkdir('evt-1'), []);
  assert.equal(fs.existsSync(path.join(work, 'database.db')), true);
});

test('실패한 재구성의 중간물은 유예가 지나면 지우되 로그는 남긴다', () => {
  const { retention, work, entries } = withDeadRun('failed', T0, T0 + DAY + 1);

  const actions = retention.purgeWorkdir('evt-1');

  assert.deepEqual(actions.map((a) => a.action), ['purge-workdir']);
  assert.equal(actions[0].bytes, 600);
  assert.match(actions[0].reason, /실패/);
  // **원본 영상은 안 지운다.** 설정만 바꿔 다시 거는 길이 막히면 안 된다.
  assert.deepEqual(fs.readdirSync(work).sort(), ['recon.log']);
  assert.equal(entries.filter((e) => e.detail.includes('중간물 파기')).length, 1);
});

test('중지된 재구성도 같은 유예를 따른다', () => {
  const early = withDeadRun('cancelled', T0, T0 + HOUR);
  assert.deepEqual(early.retention.purgeWorkdir('evt-1'), []);

  const late = withDeadRun('cancelled', T0, T0 + DAY + 1);
  assert.equal(late.retention.purgeWorkdir('evt-1').length, 1);
});

test('끝난 시각을 모르는 옛 실패 기록은 손대지 않는다', () => {
  // finishedAt이 없으면 유예를 셀 수가 없다. 셀 수 없는 것을 지우지는 않는다.
  const { incidents, retention } = bench({ now: () => T0 + 365 * DAY });
  incidents.save(record('evt-1', T0, {
    outcome: 'confirmed',
    resolvedAt: T0,
    attachments: [{ attachmentId: 'att-1', eventId: 'evt-1', kind: 'video', path: 'a.mov', recon: { status: 'failed' } }],
  }));
  const work = path.join(incidents.eventDir('evt-1'), 'recon', 'att-1');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'database.db'), 'x'.repeat(500));

  assert.deepEqual(retention.purgeWorkdir('evt-1'), []);
  assert.equal(fs.existsSync(path.join(work, 'database.db')), true);
});

test('dry-run은 무엇을 지울지만 알려주고 손대지 않는다', () => {
  const { store, incidents, retention } = bench({ dryRun: true });
  store.save(record('evt-1', T0));
  incidents.save(record('evt-2', T0 - INCIDENT - DAY, { outcome: 'confirmed', resolvedAt: T0 }));

  const actions = retention.sweep(T0 + UNDO + 1);

  assert.deepEqual(actions.map((a) => a.action), ['delete', 'delete']);
  assert.equal(store.read('evt-1') !== null, true, '아무것도 안 지웠다');
  assert.equal(incidents.read('evt-2') !== null, true);
});

test('구역 이름이 없어도 자산 이관이 죽지 않는다', () => {
  const { incidents, retention, facility } = bench();
  incidents.save({
    ...record('evt-1', T0, { outcome: 'confirmed', resolvedAt: T0 }),
    alert: { eventId: 'evt-1', ts: T0 },
    attachments: [{ attachmentId: 'att-1', eventId: 'evt-1', kind: 'splat', path: 'att-1.ply' }],
  });
  fs.writeFileSync(path.join(incidents.eventDir('evt-1'), 'att-1.ply'), 'splat');

  retention.sweep(T0 + INCIDENT + 1);
  assert.deepEqual(fs.readdirSync(path.join(facility, 'unknown')), ['unknown-01.ply']);
});
