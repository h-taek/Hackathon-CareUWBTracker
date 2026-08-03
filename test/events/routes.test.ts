import * as assert from 'node:assert/strict';
import test from 'node:test';

import { routeEvents } from '../../server/events/routes.ts';
import { summarize, type EventStore } from '../../server/events/store.ts';
import type { EventRecord } from '../../server/events/recorder.ts';

function record(eventId: string, ts: number, tagId = 'tag-a'): EventRecord {
  return {
    eventId,
    tagId,
    ts,
    alert: { eventId, tagId, ts, type: 'fall_detected' },
    track: [{ ts, x: 1, y: 2 }],
    accel: [{ ts, x: 0, y: 0, z: 9.8 }],
    attachments: [],
  };
}

/** 파일을 안 만들고 경로 동작만 본다. */
function fakeStore(records: EventRecord[]): EventStore & { limits: number[] } {
  const limits: number[] = [];
  const find = (eventId: string) => records.find((r) => r.eventId === eventId) ?? null;
  return {
    dir: '/tmp/none',
    limits,
    eventDir: (eventId) => `/tmp/none/${eventId}`,
    save: () => {},
    read: find,
    patch: (eventId, fields) => {
      const index = records.findIndex((r) => r.eventId === eventId);
      if (index < 0) return null;
      records[index] = { ...records[index], ...fields };
      return records[index];
    },
    remove: (eventId) => {
      const index = records.findIndex((r) => r.eventId === eventId);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
    list: (limit = 100) => {
      limits.push(limit);
      return [...records].sort((a, b) => b.ts - a.ts).slice(0, limit).map(summarize);
    },
  };
}

const params = (query = '') => new URLSearchParams(query);

test('GET /events는 요약 목록을 준다', () => {
  const store = fakeStore([record('evt-1', 1000), record('evt-2', 2000)]);
  const result = routeEvents('/events', params(), store);

  assert.equal(result?.status, 200);
  const body = result?.body as { events: { eventId: string }[] };
  assert.deepEqual(body.events.map((e) => e.eventId), ['evt-2', 'evt-1']);
});

test('끝의 슬래시도 목록으로 받는다', () => {
  const store = fakeStore([record('evt-1', 1000)]);
  assert.equal(routeEvents('/events/', params(), store)?.status, 200);
});

test('tagId로 목록을 좁힌다', () => {
  const store = fakeStore([record('evt-1', 1000, 'tag-a'), record('evt-2', 2000, 'tag-b')]);
  const result = routeEvents('/events', params('tagId=tag-b'), store);

  const body = result?.body as { events: { eventId: string }[] };
  assert.deepEqual(body.events.map((e) => e.eventId), ['evt-2']);
});

test('limit은 그대로 넘기고, 못 읽는 값이면 기본값을 쓴다', () => {
  const store = fakeStore([record('evt-1', 1000)]);
  routeEvents('/events', params('limit=3'), store);
  routeEvents('/events', params('limit=열개'), store);
  routeEvents('/events', params('limit=0'), store);
  routeEvents('/events', params('limit=99999'), store);

  assert.deepEqual(store.limits, [3, 100, 100, 500], '상한 500으로 자른다');
});

test('GET /events/<id>는 궤적·가속도까지 전문을 준다', () => {
  const saved = record('evt-1', 1000);
  const result = routeEvents('/events/evt-1', params(), fakeStore([saved]));

  assert.equal(result?.status, 200);
  assert.deepEqual(result?.body, saved);
});

test('없는 이벤트는 404다', () => {
  const result = routeEvents('/events/evt-9', params(), fakeStore([]));
  assert.equal(result?.status, 404);
});

test('경로를 벗어나는 eventId는 400으로 막는다', () => {
  const store = fakeStore([]);
  assert.equal(routeEvents('/events/..%2F..%2Fetc%2Fpasswd', params(), store)?.status, 400);
  assert.equal(routeEvents('/events/../../etc/passwd', params(), store)?.status, 400);
});

test('URL 인코딩된 eventId를 풀어서 찾는다', () => {
  const store = fakeStore([record('evt-tag.a-1000-1', 1000)]);
  assert.equal(routeEvents('/events/evt-tag%2Ea-1000-1', params(), store)?.status, 200);
});

test('다른 경로는 건드리지 않는다', () => {
  const store = fakeStore([]);
  assert.equal(routeEvents('/map', params(), store), null);
  assert.equal(routeEvents('/stream', params(), store), null);
  assert.equal(routeEvents('/eventsomething', params(), store), null);
});
