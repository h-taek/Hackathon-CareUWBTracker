import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgeAlert,
  applyAlertEvent,
  createAlertStore,
  dismissAlert,
  finishResolved,
  getActiveAlert,
} from '../../server/public/assets/js/alert-state.js';

const candidate = {
  type: 'fall_candidate',
  tagId: 'tag-1',
  eventId: 'candidate-1',
  ts: 100,
  peakAccel: 3.2,
  freefall: true,
  pos: { x: 1.2, y: 3.4 },
  zone: '생활실',
};

test('candidate를 만들고 confirmed로 같은 태그 경보를 승격한다', () => {
  const store = createAlertStore();
  assert.equal(applyAlertEvent(store, candidate, 100).change, 'activated');
  assert.equal(store.view, 'alerting');
  assert.equal(store.alertsByTag.size, 1);

  const result = applyAlertEvent(store, {
    ...candidate,
    type: 'fall_confirmed',
    eventId: 'confirmed-1',
    ts: 200,
  }, 200);

  assert.equal(result.change, 'updated');
  assert.equal(store.alertsByTag.size, 1);
  assert.equal(getActiveAlert(store)?.phase, 'confirmed');
  assert.deepEqual([...getActiveAlert(store)!.eventIds], ['candidate-1', 'confirmed-1']);
});

test('동일 eventId 재수신은 상태를 바꾸지 않는다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, candidate, 100);
  const result = applyAlertEvent(store, { ...candidate, type: 'fall_confirmed' }, 200);

  assert.equal(result.change, 'ignored');
  assert.equal(result.reason, 'duplicate_event');
  assert.equal(getActiveAlert(store)?.phase, 'candidate');
});

test('candidate 유실 시 confirmed만으로 활성 경보를 만든다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, {
    type: 'fall_confirmed',
    tagId: 'tag-2',
    eventId: 'confirmed-only',
    pos: null,
    zone: null,
  }, 300);

  assert.equal(store.view, 'alerting');
  assert.equal(getActiveAlert(store)?.phase, 'confirmed');
  assert.equal(getActiveAlert(store)?.pos, null);
  assert.equal(getActiveAlert(store)?.zone, null);
});

test('자동 취소는 resolved를 거쳐 idle로 복귀한다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, candidate, 100);
  const result = applyAlertEvent(store, {
    type: 'fall_canceled',
    tagId: 'tag-1',
    eventId: 'canceled-1',
  }, 400);

  assert.equal(result.change, 'resolved');
  assert.equal(store.view, 'resolved');
  assert.equal(getActiveAlert(store)?.resolution, 'auto_canceled');
  assert.equal(finishResolved(store, 'tag-1'), true);
  assert.equal(store.view, 'idle');
});

test('확인함은 경보를 유지하고 화면 닫기만 resolved로 전환한다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, candidate, 100);

  acknowledgeAlert(store, 'tag-1', 200);
  assert.equal(store.view, 'alerting');
  assert.equal(getActiveAlert(store)?.acknowledgedAt, 200);

  dismissAlert(store, 'tag-1', 300);
  assert.equal(store.view, 'resolved');
  assert.equal(getActiveAlert(store)?.resolution, 'dismissed');
});

test('확진 경보를 후보보다 우선해 대표 경보로 선택한다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, candidate, 100);
  applyAlertEvent(store, {
    type: 'fall_confirmed',
    tagId: 'tag-2',
    eventId: 'confirmed-2',
    ts: 90,
  }, 110);

  assert.equal(store.activeTagId, 'tag-2');
});
