// 명부에 없는 태그가 신호를 보내고 있다는 사실만 기억한다.
//
// UWB에는 가입 승인 절차가 없다 — 태그는 비콘을 듣고 셀을 고른 뒤 허락 없이 REPORT를
// 쏘기 시작한다(spec system 08 §2.3). 그래서 **가입을 승인하는 자리는 명부**이고,
// 승인하려면 먼저 "이런 태그가 문을 두드리고 있다"를 사람이 볼 수 있어야 한다.
// 그게 이 모듈이다.
//
// **프레임은 여전히 버린다.** 여기 남는 것은 태그 번호와 시각·횟수뿐이고, 좌표도
// 가속도도 들어오지 않는다. 등록 전에는 수집 근거가 없으므로 그 이상을 쥐고 있으면
// 안 된다(개인정보보호법 제16조① 최소수집).
//
// **디스크에 안 쓴다.** 재기동하면 사라지고, 태그가 여전히 켜져 있으면 다시 나타난다.
// 배정 판단에 필요한 순간에만 있으면 되는 값이라 파일로 남길 이유가 없다.

export interface Sighting {
  tagId: string;
  /** 처음 신호가 잡힌 시각 */
  firstSeenAt: number;
  lastSeenAt: number;
  /** 버려진 프레임 수. "잠깐 스친 것"과 "계속 보내는 중"을 가른다 */
  frames: number;
}

export interface Sightings {
  /** 미등록 태그의 프레임을 버렸다는 사실을 남긴다. 처음 본 태그면 true. */
  note(tagId: string, at?: number): boolean;
  /** 목록에서 지운다. 등록되는 순간 호출한다 — 더는 미등록이 아니다. */
  forget(tagId: string): void;
  /** 아직 신호가 살아 있는 것만. 꺼진 태그는 스스로 사라진다. */
  list(at?: number): Sighting[];
}

export interface SightingsOptions {
  /** 이만큼 조용하면 목록에서 뺀다. 꺼서 가져간 태그가 화면에 계속 남으면 안 된다. */
  expireMs?: number;
  now?: () => number;
}

export const SIGHTING_EXPIRE_MS = 60_000;

export function createSightings(options: SightingsOptions = {}): Sightings {
  const expireMs = options.expireMs ?? SIGHTING_EXPIRE_MS;
  const now = options.now ?? Date.now;
  const seen = new Map<string, Sighting>();

  return {
    note(tagId, at = now()) {
      const found = seen.get(tagId);
      if (!found) {
        seen.set(tagId, { tagId, firstSeenAt: at, lastSeenAt: at, frames: 1 });
        return true;
      }
      found.lastSeenAt = at;
      found.frames += 1;
      return false;
    },
    forget(tagId) {
      seen.delete(tagId);
    },
    list(at = now()) {
      for (const [tagId, s] of seen) {
        if (at - s.lastSeenAt > expireMs) seen.delete(tagId);
      }
      return [...seen.values()].sort((a, b) => a.firstSeenAt - b.firstSeenAt);
    },
  };
}
