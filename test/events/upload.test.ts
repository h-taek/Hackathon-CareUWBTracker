import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { createEventStore } from '../../server/events/store.ts';
import { createAttachmentStore, AttachmentError, type Attachment } from '../../server/events/attachments.ts';
import {
  handleAttachmentUpload,
  parseAttachmentPath,
  parseReconTriggerPath,
  parseUploadMeta,
} from '../../server/events/upload.ts';
import { parseAttachmentFilePath } from '../../server/events/download.ts';
import type { EventRecord } from '../../server/events/recorder.ts';

const params = (query = '') => new URLSearchParams(query);

test('업로드 경로만 골라낸다', () => {
  assert.equal(parseAttachmentPath('/events/evt-1/attachments'), 'evt-1');
  assert.equal(parseAttachmentPath('/events/evt-1/attachments/'), 'evt-1');
  assert.equal(parseAttachmentPath('/events/evt-1'), null);
  assert.equal(parseAttachmentPath('/events'), null);
  assert.equal(parseAttachmentPath('/events/evt-1/attachments/att-1'), null, '파일 내려주기 경로다');
});

test('파일 내려주기 경로와 재구성 걸기 경로를 구분한다', () => {
  assert.deepEqual(parseAttachmentFilePath('/events/evt-1/attachments/att-1'), {
    eventId: 'evt-1', attachmentId: 'att-1',
  });
  assert.equal(parseAttachmentFilePath('/events/evt-1/attachments/att-1/recon'), null);

  assert.deepEqual(parseReconTriggerPath('/events/evt-1/attachments/att-1/recon'), {
    eventId: 'evt-1', attachmentId: 'att-1',
  });
  assert.equal(parseReconTriggerPath('/events/evt-1/attachments/att-1'), null);
});

test('kind 기본값은 video다', () => {
  assert.equal(parseUploadMeta(params()).kind, 'video');
  assert.equal(parseUploadMeta(params('kind=photo')).kind, 'photo');
});

test('알 수 없는 kind는 400이다', () => {
  assert.throws(
    () => parseUploadMeta(params('kind=zip')),
    (error: unknown) => error instanceof AttachmentError && error.statusCode === 400,
  );
});

test('capturedAt이 이상하면 파일을 받기 전에 거절한다', () => {
  // 다 받아놓고 거절하면 수백 MB를 헛되이 흘린 뒤다.
  assert.equal(parseUploadMeta(params('capturedAt=1700000000000')).capturedAt, 1700000000000);
  for (const bad of ['capturedAt=어제', 'capturedAt=-1', 'capturedAt=0']) {
    assert.throws(
      () => parseUploadMeta(params(bad)),
      (error: unknown) => error instanceof AttachmentError && error.statusCode === 400,
      bad,
    );
  }
});

test('기준물체는 라벨과 실측치가 함께 와야 한다', () => {
  // 하나만 오면 스케일을 못 잡는데 레코드에는 뭔가 적혀 있어 나중에 믿게 된다.
  assert.deepEqual(
    parseUploadMeta(params('scaleLabel=A4&scaleMm=297')).scaleRef,
    { label: 'A4', measuredMm: 297 },
  );
  for (const bad of ['scaleLabel=A4', 'scaleMm=297', 'scaleLabel=A4&scaleMm=0', 'scaleLabel=A4&scaleMm=길다']) {
    assert.throws(
      () => parseUploadMeta(params(bad)),
      (error: unknown) => error instanceof AttachmentError && error.statusCode === 400,
      bad,
    );
  }
  assert.equal(parseUploadMeta(params()).scaleRef, undefined, '아예 안 주는 건 괜찮다');
});

/** 본문 스트림에 헤더·메서드를 얹어 IncomingMessage 흉내를 낸다. */
function request(body: string, method = 'POST', contentType = 'video/mp4'): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  stream.method = method;
  stream.headers = { 'content-type': contentType };
  return stream;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-'));
  const store = createEventStore(path.join(root, 'events'));
  const attachments = createAttachmentStore(store);
  const saved: EventRecord = {
    eventId: 'evt-1', tagId: 'tag-a', ts: 5000,
    alert: {}, track: [], accel: [], attachments: [],
  };
  store.save(saved);
  return { store, attachments };
}

test('영상을 받으면 201과 첨부 정보를 준다', async () => {
  const { attachments } = setup();
  const result = await handleAttachmentUpload(
    request('영상바이트'), 'evt-1', params('kind=video&name=IMG_0001.MOV'), attachments,
  );

  assert.equal(result.status, 201);
  const body = result.body as { ok: boolean; attachment: Attachment };
  assert.equal(body.ok, true);
  assert.equal(body.attachment.kind, 'video');
  assert.equal(body.attachment.recon?.status, 'pending');
});

test('저장이 끝나면 콜백으로 알린다 — 서버가 여기서 재구성을 건다', async () => {
  const { attachments } = setup();
  const notified: Attachment[] = [];

  await handleAttachmentUpload(
    request('영상'), 'evt-1', params(), attachments, (a) => notified.push(a),
  );

  assert.equal(notified.length, 1);
  assert.equal(notified[0].kind, 'video');
});

test('POST가 아니면 405다', async () => {
  const { attachments } = setup();
  const result = await handleAttachmentUpload(request('x', 'GET'), 'evt-1', params(), attachments);
  assert.equal(result.status, 405);
});

test('경로를 벗어나는 eventId는 400이다', async () => {
  const { attachments } = setup();
  const result = await handleAttachmentUpload(request('x'), '../../etc', params(), attachments);
  assert.equal(result.status, 400);
});

test('없는 이벤트는 404다', async () => {
  const { attachments } = setup();
  const result = await handleAttachmentUpload(request('x'), 'evt-none', params(), attachments);
  assert.equal(result.status, 404);
});

test('메타가 틀리면 본문을 읽기 전에 400으로 끊는다', async () => {
  const { attachments } = setup();
  const notified: Attachment[] = [];
  const result = await handleAttachmentUpload(
    request('x'), 'evt-1', params('kind=zip'), attachments, (a) => notified.push(a),
  );

  assert.equal(result.status, 400);
  assert.equal(notified.length, 0, '실패했으면 재구성도 안 걸린다');
});
