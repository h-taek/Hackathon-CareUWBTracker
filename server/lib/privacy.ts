// 사생활 구역 필터(F-6). 좌표를 구역 판정에 쓴 뒤 버린다 — spec system 03 §1.1.
//
// **이 함수는 처리 단계에 있어야 한다.** 방출(SSE) 직전에 두면 화면에서만 감춰지고
// 궤적 버퍼·이벤트 레코드·서버 로그에는 좌표가 그대로 남는다. server.ts는 평활화가
// 끝난 좌표를 여기 한 번 통과시킨 뒤, 그 결과만 기록·로그·감지기·방출에 넘긴다.
//
// 지우는 것은 **좌표와 그 좌표를 되짚을 수 있는 값**이다. pos만 지우고 앵커 거리(ranges)를
// 남기면 지운 게 아니다 — 거리 둘이면 삼각측량으로 그 자리가 다시 나온다.
// 가속도(accel)는 그대로 둔다. 낙상 판정의 입력이고, 가속도에는 위치가 들어 있지 않다.

import { findZone, type ZoneMap } from './zone.ts';

/** 필터에 들어가는 프레임. 좌표를 가진 측위 결과면 무엇이든 받는다. */
export interface PositionLike {
  tagId: string;
  pos: { x: number; y: number; z?: number };
  ranges?: unknown;
  [key: string]: unknown;
}

/** 필터를 통과한 프레임. 사생활 구역이면 pos·err가 null이고 privacy가 true다. */
export interface ZonedPosition {
  tagId: string;
  pos: { x: number; y: number; z?: number } | null;
  zone: string;
  privacy: boolean;
  [key: string]: unknown;
}

/**
 * 구역 라벨을 붙이고, 사생활 구역이면 좌표를 지운다.
 *
 * 일반 구역에서도 `privacy: false`를 **명시해서** 내보낸다. 계약(spec 03 §1.1)은
 * "없거나 false면 일반 프레임"이지만, 화면이 프레임을 누적 병합하기 때문에 필드를
 * 빼면 화장실에서 나온 뒤에도 직전 프레임의 true가 그대로 남는다.
 */
export function applyZonePolicy<T extends PositionLike>(map: ZoneMap, position: T): ZonedPosition {
  const zone = findZone(map, position.pos.x, position.pos.y);
  const label = zone?.label ?? '미지정';
  if (!zone?.privacy) return { ...position, zone: label, privacy: false };

  // 좌표를 되짚을 수 있는 값은 전부 뺀다. 남는 것은 태그·시각·가속도·구역명이다.
  const { pos: _pos, ranges: _ranges, geom: _geom, estimate: _estimate, hold: _hold, ...rest } = position;
  return { ...rest, tagId: position.tagId, pos: null, zone: label, privacy: true };
}

/** 이 프레임은 사생활 정책으로 좌표가 지워진 것인가(측위 실패와 구분한다). */
export function isPrivacyFrame(frame: unknown): boolean {
  return (frame as { privacy?: unknown } | null)?.privacy === true;
}
