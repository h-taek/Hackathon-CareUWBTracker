// 사고 기록 조회 경로(R-1). 응답을 만들기만 하고 쓰지는 않는다 — 순수 함수라 서버를 안 띄우고
// 테스트할 수 있고, server.ts의 sendJson을 그대로 재사용한다.
//
//   GET /events            최신순 목록(요약). ?limit= 개수, ?tagId= 태그, ?outcome= 판정
//   GET /events/<eventId>  레코드 전문(궤적·가속도 포함)
//
// 쓰는 경로(판정·번복·삭제)는 여기 없다. 이 파일이 순수한 채로 있어야 서버를 안 띄우고
// 테스트할 수 있다.

import { DEFAULT_EVENT_LIST_LIMIT, isValidEventId, type EventStore } from './store.ts';
import { isOutcome } from './outcome.ts';

export interface EventRouteResult {
  status: number;
  body: unknown;
}

const MAX_EVENT_LIST_LIMIT = 500;

export function routeEvents(
  pathname: string,
  params: URLSearchParams,
  store: EventStore,
  /** 번복 창 길이(ms). 화면이 "언제까지 뒤집을 수 있나"를 계산하는 데 쓴다(spec 11 §3). */
  undoWindowMs = 0,
): EventRouteResult | null {
  if (pathname === '/events' || pathname === '/events/') {
    const tagId = params.get('tagId');
    const outcome = params.get('outcome');
    if (outcome !== null && !isOutcome(outcome)) {
      return { status: 400, body: { ok: false, error: `잘못된 outcome: ${outcome}` } };
    }
    const events = store.list(parseLimit(params.get('limit')))
      .filter((summary) => !tagId || summary.tagId === tagId)
      .filter((summary) => !outcome || summary.outcome === outcome);
    return { status: 200, body: { events, undoWindowMs } };
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

/** `/events/<eventId>/outcome`이면 eventId를, 아니면 null. 판정·번복 경로다. */
export function parseOutcomePath(pathname: string): string | null {
  const match = /^\/events\/([^/]+)\/outcome\/?$/.exec(pathname);
  return match ? decodeSegment(match[1]) : null;
}

/** `/incidents/<id>/purge-workdir`이면 id를, 아니면 null. 재구성 중간물만 지운다. */
export function parsePurgeWorkdirPath(pathname: string): string | null {
  const match = /^\/incidents\/([^/]+)\/purge-workdir\/?$/.exec(pathname);
  return match ? decodeSegment(match[1]) : null;
}

/**
 * 확인 사건 조회. 감지 이벤트와 **다른 폴더**를 읽는다(spec operation 02 §2).
 *
 *   GET /incidents            최신순 목록(요약)
 *   GET /incidents/<id>       레코드 전문
 *
 * 사건은 판정이 `confirmed`가 될 때 만들어진 이벤트의 사본이라, 원본 이벤트를 지워도
 * 여기 남는다. 그래서 `?outcome=` 같은 필터가 없다 — 여기 있는 것은 전부 확인된 사고다.
 */
export function routeIncidents(
  pathname: string,
  params: URLSearchParams,
  store: EventStore,
): EventRouteResult | null {
  if (pathname === '/incidents' || pathname === '/incidents/') {
    return { status: 200, body: { incidents: store.list(parseLimit(params.get('limit'))) } };
  }
  if (!pathname.startsWith('/incidents/')) return null;

  const id = decodeSegment(pathname.slice('/incidents/'.length));
  if (!isValidEventId(id)) {
    return { status: 400, body: { ok: false, error: `잘못된 사건 id: ${id}` } };
  }
  const record = store.read(id);
  if (!record) return { status: 404, body: { ok: false, error: `없는 사건: ${id}` } };
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
