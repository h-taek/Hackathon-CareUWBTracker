const PHASE_BY_TYPE = {
  fall_candidate: 'candidate',
  fall_confirmed: 'confirmed',
  fall_canceled: 'canceled',
};

const activeAlerts = (store) => [...store.alertsByTag.values()]
  .filter((alert) => alert.resolvedAt === null)
  .sort((a, b) => {
    const severity = (phase) => phase === 'confirmed' ? 2 : 1;
    return severity(b.phase) - severity(a.phase) || b.updatedAt - a.updatedAt;
  });

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
  const phase = event && PHASE_BY_TYPE[event.type];
  if (!phase || typeof event.tagId !== 'string' || !event.tagId) {
    return { change: 'ignored', reason: 'invalid_event', alert: null };
  }
  if (event.eventId && store.processedEventIds.has(event.eventId)) {
    return { change: 'ignored', reason: 'duplicate_event', alert: null };
  }
  if (event.eventId) store.processedEventIds.add(event.eventId);

  const previous = store.alertsByTag.get(event.tagId);
  if (phase === 'canceled' && !previous) {
    return { change: 'ignored', reason: 'unknown_alert', alert: null };
  }

  const eventAt = Number.isFinite(event.ts) ? event.ts : receivedAt;
  const eventIds = new Set(previous ? previous.eventIds : []);
  if (event.eventId) eventIds.add(event.eventId);
  const alert = {
    tagId: event.tagId,
    name: event.name || (previous && previous.name) || null,
    eventIds,
    phase,
    firstDetectedAt: previous ? previous.firstDetectedAt : eventAt,
    updatedAt: eventAt,
    acknowledgedAt: previous ? previous.acknowledgedAt : null,
    resolvedAt: phase === 'canceled' ? receivedAt : null,
    resolution: phase === 'canceled' ? 'auto_canceled' : null,
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

  if (phase === 'canceled') {
    const next = selectActive(store);
    store.view = next ? 'alerting' : 'resolved';
    if (!next) store.activeTagId = event.tagId;
    return { change: 'resolved', reason: 'auto_canceled', alert };
  }

  const wasActive = store.activeTagId === event.tagId && previous && previous.resolvedAt === null;
  store.view = 'alerting';
  selectActive(store);
  return { change: wasActive ? 'updated' : 'activated', reason: null, alert };
}

export function acknowledgeAlert(store, tagId, acknowledgedAt = Date.now()) {
  const alert = store.alertsByTag.get(tagId);
  if (!alert || alert.resolvedAt !== null) return null;
  alert.acknowledgedAt = acknowledgedAt;
  return alert;
}

export function dismissAlert(store, tagId, dismissedAt = Date.now()) {
  const alert = store.alertsByTag.get(tagId);
  if (!alert || alert.resolvedAt !== null) return null;
  alert.resolvedAt = dismissedAt;
  alert.resolution = 'dismissed';
  const next = selectActive(store);
  store.view = next ? 'alerting' : 'resolved';
  if (!next) store.activeTagId = tagId;
  return alert;
}

export function finishResolved(store, tagId) {
  if (store.view !== 'resolved' || store.activeTagId !== tagId) return false;
  store.view = 'idle';
  store.activeTagId = null;
  return true;
}

export function getActiveAlert(store) {
  return store.activeTagId ? store.alertsByTag.get(store.activeTagId) || null : null;
}
