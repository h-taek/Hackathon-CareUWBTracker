// 관제 세션 — 지금 화면 앞에 앉은 사람이 누구인가(spec operation 03 §3).
//
// **메모리에만 둔다.** 파일로 남기면 서버가 내려가 있던 사이에 교대가 있었는지 알 방법이
// 없는데 세션만 살아남아, 어제 사람의 이름으로 오늘의 판정이 찍힌다. 재기동하면 다시
// 고르는 것이 맞는 동작이다.
//
// **3시간 절대 만료다.** 마지막 조작이 아니라 발급 시각부터 잰다 — 조용한 관제사가 영원히
// 로그인 상태로 남는 것을 막는다. 한 교대를 넘기지 않는 길이다.

import { randomUUID } from 'node:crypto';

export const SESSION_COOKIE = 'op_sid';
export const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

export interface Session {
  sid: string;
  operatorId: string;
  openedAt: number;
  /** 에폭 ms. 화면이 이 시각에 타이머로 선택창을 연다. */
  expiresAt: number;
}

export interface SessionStore {
  open(operatorId: string): Session;
  /** 살아 있는 세션만 준다. 만료됐으면 지우면서 `onExpire`를 부르고 `null`. */
  get(sid: string | null | undefined): Session | null;
  /** 교대 종료. */
  close(sid: string | null | undefined): Session | null;
  /** 그 관제사의 세션을 끊는다. **명부에서 지울 때 쓴다**(spec operation 03 §2). */
  closeOperator(operatorId: string): Session | null;
  ttlMs: number;
}

export interface SessionStoreOptions {
  now?: () => number;
  ttlMs?: number;
  /** 만료를 확인자료에 남기는 창구. 만료는 조회하는 순간 발견된다. */
  onExpire?: (session: Session) => void;
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  // 시설당 서버 1대에 관제 화면 몇 개다. 자료구조를 더 쓸 규모가 아니다.
  const sessions = new Map<string, Session>();

  return {
    open(operatorId) {
      const openedAt = now();
      const session: Session = { sid: randomUUID(), operatorId, openedAt, expiresAt: openedAt + ttlMs };
      sessions.set(session.sid, session);
      return session;
    },
    get(sid) {
      if (!sid) return null;
      const session = sessions.get(sid);
      if (!session) return null;
      if (now() >= session.expiresAt) {
        sessions.delete(sid);
        options.onExpire?.(session);
        return null;
      }
      return session;
    },
    close(sid) {
      if (!sid) return null;
      const session = sessions.get(sid);
      if (!session) return null;
      sessions.delete(sid);
      return session;
    },
    closeOperator(operatorId) {
      for (const [sid, session] of sessions) {
        if (session.operatorId !== operatorId) continue;
        sessions.delete(sid);
        return session;
      }
      return null;
    },
    ttlMs,
  };
}

/** `Cookie` 헤더에서 하나를 꺼낸다. 쿠키를 이거 하나만 쓰므로 파서를 들이지 않는다. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const cut = part.indexOf('=');
    if (cut < 0) continue;
    if (part.slice(0, cut).trim() !== name) continue;
    return decodeURIComponent(part.slice(cut + 1).trim()) || null;
  }
  return null;
}

/**
 * `Set-Cookie` 값.
 *
 * `HttpOnly`라 화면 스크립트가 읽지 못한다 — 행위자는 서버가 정하고, 화면은 `GET /session`으로
 * 물어볼 뿐이다. `Secure`는 붙이지 않는다. 시설 내부망 http로 뜨는 서버라 붙이면 쿠키가
 * 아예 안 실린다.
 */
export function sessionCookie(sid: string, maxAgeMs: number): string {
  const maxAge = Math.max(0, Math.floor(maxAgeMs / 1000));
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** 지우는 쿠키. 교대 종료에 쓴다. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
