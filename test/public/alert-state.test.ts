import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAlertEvent,
  createAlertStore,
  dismissAlert,
  getActiveAlert,
} from '../../server/public/assets/js/alert-state.js';

const detected = {
  type: 'fall_detected',
  tagId: 'tag-1',
  eventId: 'detected-1',
  ts: 100,
  peakAccel: 3.2,
  freefall: true,
  pos: { x: 1.2, y: 3.4 },
  zone: '생활실',
};

test('감지 이벤트 하나가 활성 경보를 만든다', () => {
  const store = createAlertStore();
  const result = applyAlertEvent(store, detected, 100);

  assert.equal(result.change, 'activated');
  assert.equal(store.view, 'alerting');
  assert.equal(store.alertsByTag.size, 1);
  const alert = getActiveAlert(store)!;
  assert.equal(alert.peakAccel, 3.2);
  assert.equal(alert.freefall, true);
  assert.deepEqual(alert.pos, { x: 1.2, y: 3.4 });
  assert.equal(alert.zone, '생활실');
  assert.equal(alert.resolvedAt, null);
});

test('감지 말고 다른 이벤트는 전부 버린다 — 단계는 하나뿐이다', () => {
  const store = createAlertStore();
  for (const type of ['fall_candidate', 'fall_confirmed', 'fall_canceled', 'fall_movement']) {
    const result = applyAlertEvent(store, { ...detected, type, eventId: type }, 100);
    assert.equal(result.change, 'ignored', `${type}이 경보를 만들면 안 된다`);
    assert.equal(result.reason, 'invalid_event');
  }
  assert.equal(store.view, 'idle');
  assert.equal(store.alertsByTag.size, 0);
});

test('동일 eventId 재수신은 상태를 바꾸지 않는다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, detected, 100);
  const result = applyAlertEvent(store, { ...detected, peakAccel: 9.9 }, 200);

  assert.equal(result.change, 'ignored');
  assert.equal(result.reason, 'duplicate_event');
  assert.equal(getActiveAlert(store)!.peakAccel, 3.2);
});

test('쿨다운 뒤 같은 태그의 새 충격은 기존 경보를 갱신한다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, detected, 100);
  const result = applyAlertEvent(store, {
    ...detected, eventId: 'detected-2', ts: 10100, peakAccel: 5.5,
  }, 10100);

  assert.equal(result.change, 'updated');
  assert.equal(store.alertsByTag.size, 1, '태그당 경보는 하나다');
  const alert = getActiveAlert(store)!;
  assert.equal(alert.peakAccel, 5.5);
  assert.equal(alert.firstDetectedAt, 100, '최초 감지 시각은 남는다');
  assert.equal(alert.updatedAt, 10100);
  assert.deepEqual([...alert.eventIds], ['detected-1', 'detected-2']);
});

test('경보를 끝내는 경로는 관제사의 종료뿐이다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, detected, 100);
  assert.equal(store.view, 'alerting');

  dismissAlert(store, 'tag-1', 300);
  assert.equal(store.view, 'idle');
  assert.equal(store.activeTagId, null);
  assert.equal(store.alertsByTag.get('tag-1')!.resolution, 'dismissed');
});

test('이미 끝낸 경보는 다시 끝낼 수 없다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, detected, 100);
  assert.ok(dismissAlert(store, 'tag-1', 300));
  assert.equal(dismissAlert(store, 'tag-1', 400), null);
});

test('경보 하나를 끝내도 남은 경보가 있으면 alerting을 유지한다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, detected, 100);
  applyAlertEvent(store, {
    ...detected, tagId: 'tag-2', eventId: 'detected-2', ts: 110,
  }, 110);

  assert.equal(store.activeTagId, 'tag-2', '최근 것이 대표다');
  dismissAlert(store, 'tag-2', 300);
  assert.equal(store.view, 'alerting');
  assert.equal(store.activeTagId, 'tag-1');
});

test('tagId 없는 이벤트는 버린다', () => {
  const store = createAlertStore();
  assert.equal(applyAlertEvent(store, { type: 'fall_detected' }, 100).change, 'ignored');
  assert.equal(store.view, 'idle');
});

test('좌표·구역이 없어도 경보는 만든다 — 측위 실패가 경보를 삼키면 안 된다', () => {
  const store = createAlertStore();
  applyAlertEvent(store, {
    type: 'fall_detected', tagId: 'tag-3', eventId: 'nopos', pos: null, zone: null,
  }, 300);

  assert.equal(store.view, 'alerting');
  assert.equal(getActiveAlert(store)!.pos, null);
  assert.equal(getActiveAlert(store)!.zone, null);
});
