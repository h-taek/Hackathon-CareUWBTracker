/**
 * NI 토큰 우편함. 앵커 폰 두 대가 서로의 NIDiscoveryToken을 건네는 자리다.
 *
 * **왜 서버가 이 일을 하나.**
 * 워치는 짝지어진 폰 한 대와만 통신할 수 있어서(WCSession), 서브폰 몫 토큰은 처음부터 메인폰이
 * 중계해 왔다. 그 폰↔폰 한 구간을 여태 Bonjour 직접 무선으로 붙였는데, 같은 공유기에 물려 있어도
 * AP가 단말 간 통신이나 멀티캐스트를 막으면 서로를 **발견**하지 못해 토큰이 건너가지 못한다.
 * IP가 통하는 것과 mDNS로 찾아지는 것은 다른 문제다.
 * 서버는 두 폰이 이미 주소를 알고 있는 유일한 지점이다 — 메인폰은 여기로 초당 50번 POST한다.
 * 그래서 "서로를 찾는" 단계를 없애고 "아는 주소에 놓고 가져오기"로 바꾼다.
 *
 * **개인정보가 아니다.** discoveryToken은 무선 링크를 여는 임시 식별자일 뿐, 위치도 사람도 담지
 * 않는다. 그래도 디스크에는 쓰지 않는다 — 만료되면 사라지는 메모리 상태다(명부와 다른 성격).
 *
 * **묵은 토큰이 스스로 죽는다.** 앱을 다시 켜면 세션이 새 토큰을 만드는데, 옛 토큰이 남아 있으면
 * 양쪽이 서로의 죽은 세션을 붙잡고 "연결됨"만 뜬 채 거리가 0인 상태가 된다(예전에 한 번 겪은 함정).
 * 여기서는 같은 (받는이, 보낸이) 자리를 덮어쓰고, 갱신이 끊기면 만료로 사라진다.
 */

/** 이 시간(ms) 넘게 다시 놓이지 않은 토큰은 없는 것으로 친다. 보내는 쪽이 1.5초마다 다시 놓는다. */
export const TOKEN_EXPIRE_MS = 15_000;

/** 앱이 JSON으로 부호화한 `AddressedToken` 그대로. token은 base64(Swift JSONEncoder 기본). */
export type TokenMessage = {
  from: string;
  to: string;
  token: string;
};

export type StoredToken = TokenMessage & { at: number };

export type TokenMailbox = {
  put(message: TokenMessage, at?: number): StoredToken;
  /** 받는이 앞으로 온 것들. 살아 있는 것만 준다. **가져가도 지우지 않는다** — 아래 주석 참고. */
  take(to: string, at?: number): StoredToken[];
  size(at?: number): number;
  clear(): void;
};

/** 기기 역할 ID(`phoneMain`·`phoneSub`·`tag-watch`)의 모양. */
export function isPeerId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/** base64 토큰. NIDiscoveryToken 아카이브는 수백 바이트라, 이 상한은 넉넉하면서 남용을 막는다. */
const MAX_TOKEN_CHARS = 8192;

export function parseTokenMessage(value: unknown): TokenMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const { from, to, token } = value as Record<string, unknown>;
  if (!isPeerId(from) || !isPeerId(to)) return null;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  return { from, to, token };
}

export function createTokenMailbox(options: { expireMs?: number; now?: () => number } = {}): TokenMailbox {
  const expireMs = options.expireMs ?? TOKEN_EXPIRE_MS;
  const now = options.now ?? (() => Date.now());
  // 받는이 -> (보낸이 -> 토큰). 보낸이마다 최신 한 통만 둔다.
  const boxes = new Map<string, Map<string, StoredToken>>();

  function prune(at: number): void {
    for (const [to, box] of boxes) {
      for (const [from, entry] of box) {
        if (at - entry.at > expireMs) box.delete(from);
      }
      if (box.size === 0) boxes.delete(to);
    }
  }

  return {
    put(message, at = now()) {
      const entry: StoredToken = { ...message, at };
      const box = boxes.get(message.to) ?? new Map<string, StoredToken>();
      // 덮어쓴다. 같은 보낸이의 옛 토큰이 남아 있으면 그게 곧 묵은 토큰이다.
      box.set(message.from, entry);
      boxes.set(message.to, box);
      prune(at);
      return entry;
    },
    // 지우지 않는 이유: 응답이 한 번 유실되면 토큰도 같이 사라져 다음 재전송까지 붙지 못한다.
    // 받는 쪽은 같은 토큰을 다시 받아도 아무 일도 하지 않으므로(app: runningToken 비교) 무해하고,
    // 재시작한 폰이 곧바로 현재 토큰을 집어갈 수 있다. 정리는 만료가 맡는다.
    take(to, at = now()) {
      prune(at);
      return [...(boxes.get(to)?.values() ?? [])].sort((a, b) => a.at - b.at);
    },
    size(at = now()) {
      prune(at);
      let total = 0;
      for (const box of boxes.values()) total += box.size;
      return total;
    },
    clear() {
      boxes.clear();
    },
  };
}
