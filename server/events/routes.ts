// 사고 기록 조회 경로(R-1). 응답을 만들기만 하고 쓰지는 않는다 — 순수 함수라 서버를 안 띄우고
// 테스트할 수 있고, server.ts의 sendJson을 그대로 재사용한다.
//
//   GET /events            최신순 목록(요약). ?limit= 로 개수, ?tagId= 로 태그 한정
//   GET /events/<eventId>  레코드 전문(궤적·가속도 포함)

import { DEFAULT_EVENT_LIST_LIMIT, isValidEventId, type EventStore } from './store.ts';

export interface EventRouteResult {
  status: number;
  body: unknown;
}

const MAX_EVENT_LIST_LIMIT = 500;

export function routeEvents(
  pathname: string,
  params: URLSearchParams,
  store: EventStore,
): EventRouteResult | null {
  if (pathname === '/events' || pathname === '/events/') {
    const tagId = params.get('tagId');
    const events = store.list(parseLimit(params.get('limit')))
      .filter((summary) => !tagId || summary.tagId === tagId);
    return { status: 200, body: { events } };
  }

  if (!pathname.startsWith('/events/')) return null;

  const eventId = decodeSegment(pathname.slice('/events/'.length));
  if (!isValidEventId(eventId)) {
    return { status: 400, body: { ok: false, error: `잘못된 eventId: ${eventId}` } };
  }

  const record = store.read(eventId);
  if (!record) return { status: 404, body: { ok: false, error: `없는 이벤트: ${eventId}` } };
  return { status: 200, body: record };
}

function parseLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EVENT_LIST_LIMIT;
  return Math.min(Math.floor(parsed), MAX_EVENT_LIST_LIMIT);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // %가 깨진 경로. isValidEventId가 어차피 막는다
  }
}
