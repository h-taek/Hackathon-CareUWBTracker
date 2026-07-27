// 경보는 한 종류뿐이다. 감지기가 fall_detected 하나를 내고 끝나며(detection/fall.ts),
// 승격도 자동 해제도 없다. 경보를 지우는 경로는 관제사의 dismissAlert() 하나다.
const ALERT_TYPE = 'fall_detected';

// 단계가 하나뿐이라 심각도 비교가 없다. 최근에 갱신된 경보가 대표가 된다.
const activeAlerts = (store) => [...store.alertsByTag.values()]
  .filter((alert) => alert.resolvedAt === null)
  .sort((a, b) => b.updatedAt - a.updatedAt);

const selectActive = (store) => {
  const next = activeAlerts(store)[0] || null;
  store.activeTagId = next ? next.tagId : null;
  return next;
};

export function createAlertStore() {
  return {
    view: 'idle',
    activeTagId: null,
    alertsByTag: new Map(),
    processedEventIds: new Set(),
  };
}

export function applyAlertEvent(store, event, receivedAt = Date.now()) {
  if (!event || event.type !== ALERT_TYPE || typeof event.tagId !== 'string' || !event.tagId) {
    return { change: 'ignored', reason: 'invalid_event', alert: null };
  }
  if (event.eventId && store.processedEventIds.has(event.eventId)) {
    return { change: 'ignored', reason: 'duplicate_event', alert: null };
  }
  if (event.eventId) store.processedEventIds.add(event.eventId);

  const previous = store.alertsByTag.get(event.tagId);

  const eventAt = Number.isFinite(event.ts) ? event.ts : receivedAt;
  const eventIds = new Set(previous ? previous.eventIds : []);
  if (event.eventId) eventIds.add(event.eventId);
  const alert = {
    tagId: event.tagId,
    name: event.name || (previous && previous.name) || null,
    eventIds,
    firstDetectedAt: previous ? previous.firstDetectedAt : eventAt,
    updatedAt: eventAt,
    resolvedAt: null,
    resolution: null,
    peakAccel: Number.isFinite(event.peakAccel)
      ? event.peakAccel
      : (previous ? previous.peakAccel : null),
    freefall: typeof event.freefall === 'boolean'
      ? event.freefall
      : (previous ? previous.freefall : null),
    aiScore: Number.isFinite(event.aiScore)
      ? event.aiScore
      : (previous ? previous.aiScore : null),
    pos: event.pos && Number.isFinite(event.pos.x) && Number.isFinite(event.pos.y)
      ? { x: event.pos.x, y: event.pos.y }
      : (previous ? previous.pos : null),
    zone: typeof event.zone === 'string' && event.zone
      ? event.zone
      : (previous ? previous.zone : null),
  };
  store.alertsByTag.set(event.tagId, alert);

  // 쿨다운이 끝난 뒤 같은 태그에서 새 충격이 오면, 아직 안 닫은 경보를 갱신한다.
  const wasActive = store.activeTagId === event.tagId && previous && previous.resolvedAt === null;
  store.view = 'alerting';
  selectActive(store);
  return { change: wasActive ? 'updated' : 'activated', reason: null, alert };
}

/** 경보를 끝내는 유일한 경로. 감지기가 아니라 관제사만 이걸 부른다. */
export function dismissAlert(store, tagId, dismissedAt = Date.now()) {
  const alert = store.alertsByTag.get(tagId);
  if (!alert || alert.resolvedAt !== null) return null;
  alert.resolvedAt = dismissedAt;
  alert.resolution = 'dismissed';
  const next = selectActive(store);
  store.view = next ? 'alerting' : 'idle';
  return alert;
}

export function getActiveAlert(store) {
  return store.activeTagId ? store.alertsByTag.get(store.activeTagId) || null : null;
}
