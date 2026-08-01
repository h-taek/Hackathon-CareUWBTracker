import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { createEventStore } from '../../server/events/store.ts';
import {
  AttachmentError,
  RECON_PIPELINE,
  attachmentsOf,
  createAttachmentStore,
  isAttachmentKind,
} from '../../server/events/attachments.ts';
import type { EventRecord } from '../../server/events/recorder.ts';

function record(eventId: string, ts = 5000): EventRecord {
  return {
    eventId,
    tagId: 'tag-a',
    ts,
    alert: { eventId, type: 'fall_detected', ts },
    track: [{ ts, x: 1, y: 2 }],
    accel: [{ ts, x: 0, y: 0, z: 9.8 }],
    attachments: [],
  };
}

let clock = 1_700_000_000_000;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'att-'));
  const store = createEventStore(path.join(root, 'events'));
  const attachments = createAttachmentStore(store, { now: () => (clock += 1000) });
  store.save(record('evt-1'));
  return { store, attachments, root };
}

const bytes = (text: string) => Readable.from([Buffer.from(text)]);

test('영상을 받아 이벤트 폴더에 넣고 레코드에 붙인다', async () => {
  const { store, attachments } = setup();

  const saved = await attachments.receive(
    'evt-1',
    { kind: 'video', originalName: '사고현장.MOV', capturedAt: 5500 },
    bytes('영상바이트'),
  );

  assert.equal(saved.kind, 'video');
  assert.equal(saved.eventId, 'evt-1');
  assert.equal(saved.capturedAt, 5500);
  assert.equal(saved.originalName, '사고현장.MOV');
  assert.ok(saved.bytes > 0);
  // 파일 이름은 attachmentId로 짓는다 — 올라온 이름을 경로로 쓰지 않는다.
  assert.equal(saved.path, `${saved.attachmentId}.mov`);
  assert.ok(fs.existsSync(path.join(store.eventDir('evt-1'), saved.path)));

  assert.deepEqual(attachmentsOf(store.read('evt-1')).map((a) => a.attachmentId), [saved.attachmentId]);
});

test('영상은 붙는 순간부터 재구성 대기다', async () => {
  const { attachments } = setup();
  const saved = await attachments.receive('evt-1', { kind: 'video' }, bytes('x'));

  assert.equal(saved.recon?.status, 'pending');
  assert.equal(saved.recon?.pipeline, RECON_PIPELINE);
});

test('사진과 산출물은 재구성 대상이 아니다', async () => {
  const { attachments } = setup();
  const photo = await attachments.receive('evt-1', { kind: 'photo' }, bytes('x'));
  const splat = await attachments.receive('evt-1', { kind: 'splat' }, bytes('x'));

  assert.equal(photo.recon, undefined);
  assert.equal(splat.recon, undefined);
  assert.equal(photo.path.endsWith('.jpg'), true);
  assert.equal(splat.path.endsWith('.ply'), true);
});

test('기준물체 실측값을 recon에 싣는다', async () => {
  // 이게 없으면 재구성 결과의 절대 크기를 못 믿는다(research 06 §1.2).
  const { attachments } = setup();
  const saved = await attachments.receive(
    'evt-1',
    { kind: 'video', scaleRef: { label: 'A4 용지 긴 변', measuredMm: 297 } },
    bytes('x'),
  );

  assert.deepEqual(saved.recon?.scaleRef, { label: 'A4 용지 긴 변', measuredMm: 297 });
});

test('확장자는 허용 목록 안에서만 고르고, 벗어나면 종류별 기본값으로 떨어진다', async () => {
  const { attachments } = setup();

  const evil = await attachments.receive(
    'evt-1',
    { kind: 'video', originalName: '../../../etc/passwd.sh' },
    bytes('x'),
  );
  assert.equal(evil.path, `${evil.attachmentId}.mp4`);
  assert.equal(evil.path.includes('/'), false);

  const byType = await attachments.receive(
    'evt-1',
    { kind: 'video', contentType: 'video/quicktime' },
    bytes('x'),
  );
  assert.equal(byType.path.endsWith('.mov'), true);
});

test('capturedAt이 없으면 업로드 시각으로 채운다', async () => {
  const { attachments } = setup();
  const saved = await attachments.receive('evt-1', { kind: 'video' }, bytes('x'));

  assert.equal(saved.capturedAt, saved.uploadedAt);
});

test('없는 이벤트에는 붙지 않는다 — 파일도 안 남긴다', async () => {
  const { attachments, store } = setup();

  await assert.rejects(
    () => attachments.receive('evt-none', { kind: 'video' }, bytes('x')),
    (error: unknown) => error instanceof AttachmentError && error.statusCode === 404,
  );
  assert.equal(fs.existsSync(path.join(store.dir, 'evt-none')), false);
});

test('빈 첨부는 거절하고 반쪽 파일을 안 남긴다', async () => {
  const { attachments, store } = setup();

  await assert.rejects(
    () => attachments.receive('evt-1', { kind: 'video' }, Readable.from([])),
    (error: unknown) => error instanceof AttachmentError && error.statusCode === 400,
  );
  assert.deepEqual(fs.readdirSync(store.eventDir('evt-1')), ['record.json']);
});

test('한도를 넘으면 413이고 받다 만 파일은 지운다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'att-'));
  const store = createEventStore(path.join(root, 'events'));
  const attachments = createAttachmentStore(store, { limitBytes: 10 });
  store.save(record('evt-1'));

  await assert.rejects(
    () => attachments.receive('evt-1', { kind: 'video' }, bytes('열 바이트를 훌쩍 넘는 본문')),
    (error: unknown) => error instanceof AttachmentError && error.statusCode === 413,
  );
  assert.deepEqual(fs.readdirSync(store.eventDir('evt-1')), ['record.json']);
});

test('알 수 없는 kind는 400이다', async () => {
  const { attachments } = setup();
  await assert.rejects(
    () => attachments.receive('evt-1', { kind: 'zip' as never }, bytes('x')),
    (error: unknown) => error instanceof AttachmentError && error.statusCode === 400,
  );
  assert.equal(isAttachmentKind('video'), true);
  assert.equal(isAttachmentKind('zip'), false);
});

test('첨부를 여러 개 붙여도 서로 덮어쓰지 않는다', async () => {
  const { store, attachments } = setup();
  const a = await attachments.receive('evt-1', { kind: 'video' }, bytes('하나'));
  const b = await attachments.receive('evt-1', { kind: 'video' }, bytes('둘'));

  assert.notEqual(a.attachmentId, b.attachmentId);
  assert.equal(attachmentsOf(store.read('evt-1')).length, 2);
});

test('재구성 상태를 전이시킨다 — pending → running → done', async () => {
  const { attachments } = setup();
  const video = await attachments.receive('evt-1', { kind: 'video' }, bytes('x'));

  attachments.patchRecon('evt-1', video.attachmentId, { status: 'running', startedAt: 111 });
  assert.equal(attachments.get('evt-1', video.attachmentId)?.recon?.status, 'running');

  attachments.patchRecon('evt-1', video.attachmentId, { status: 'done', outputAttachmentId: 'att-9' });
  const done = attachments.get('evt-1', video.attachmentId);
  assert.equal(done?.recon?.status, 'done');
  assert.equal(done?.recon?.outputAttachmentId, 'att-9');
  assert.equal(done?.recon?.startedAt, 111, '앞서 채운 값이 유지된다');
});

test('없는 첨부의 상태 전이는 null이다', async () => {
  const { attachments } = setup();
  assert.equal(attachments.patchRecon('evt-1', 'att-없음', { status: 'done' }), null);
});

test('이미 이벤트 폴더 안에 있는 파일은 옮기지 않고 그 자리를 가리킨다', () => {
  // 재구성 산출물이 recon/ 아래에 생기는데, 굳이 옮기면 로그와 짝이 어긋난다.
  const { store, attachments } = setup();
  const inside = path.join(store.eventDir('evt-1'), 'recon', 'att-1', 'scene.ply');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, 'ply본문', 'utf8');

  const saved = attachments.attachLocalFile(
    'evt-1',
    { kind: 'splat', sourceAttachmentId: 'att-1' },
    inside,
  );

  assert.equal(saved.path, path.join('recon', 'att-1', 'scene.ply'));
  assert.equal(saved.sourceAttachmentId, 'att-1');
  assert.equal(fs.existsSync(inside), true, '옮기지 않았다');
  assert.equal(attachments.absolutePathOf(saved), inside);
});

test('바깥 파일을 첨부로 등록하면 이벤트 폴더로 옮긴다', () => {
  const { store, attachments, root } = setup();
  const outside = path.join(root, 'scene.ply');
  fs.writeFileSync(outside, 'ply본문', 'utf8');

  const saved = attachments.attachLocalFile('evt-1', { kind: 'splat' }, outside);

  assert.equal(saved.path, `${saved.attachmentId}.ply`);
  assert.equal(fs.existsSync(outside), false, '원본은 옮겨졌다');
  assert.equal(fs.existsSync(path.join(store.eventDir('evt-1'), saved.path)), true);
});

test('attachmentsOf는 배열이 아니면 빈 배열을 준다', () => {
  assert.deepEqual(attachmentsOf(null), []);
  assert.deepEqual(attachmentsOf({}), []);
  assert.deepEqual(attachmentsOf({ attachments: '아님' }), []);
});
