// 관제사의 판정과 그 전이 규칙(spec operation 02 §3).
//
// **감지기는 낙상 여부만 알고, 그것이 실제였는지는 사람만 안다.** 그래서 판정은 관제사만 낸다.
// 이 값이 정하는 것은 하나다 — **확인 사건 사본을 만들지 말지.**
//
// 감지 이벤트와 확인 사건은 서로 다른 폴더에 산다(spec operation 02 §2). 판정이 confirmed가
// 되면 이벤트의 사본이 사건 저장소에 생기고, 번복하면 그 사본이 지워진다. 둘의 삭제와
// 보관기간은 그때부터 완전히 독립이다 — 로그를 지워도 사건은 남는다.
//
// 파일을 안 건드린다. 레코드 객체를 받아 다음 상태를 계산할 뿐이라, 저장은 store.ts가 쥔다.

/** 관제사가 아직 안 본 상태. `outcome` 필드가 없는 옛 레코드도 이걸로 읽는다. */
export const DETECTED = 'detected';
/** 실제 낙상. 이 순간 사건 사본이 만들어진다. */
export const CONFIRMED = 'confirmed';
/** 오경보. 사건 사본이 있었다면 같이 지워진다. */
export const FALSE_ALARM = 'false_alarm';

export const OUTCOMES = [DETECTED, CONFIRMED, FALSE_ALARM] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** 관제사가 직접 낼 수 있는 값. `detected`는 판정 전 상태라 여기 없다. */
export const JUDGMENTS = [CONFIRMED, FALSE_ALARM] as const;
export type Judgment = (typeof JUDGMENTS)[number];

export interface OutcomeChange {
  at: number;
  from: Outcome;
  to: Outcome;
  /** 누가 뒤집었는지. 관제 화면 인증이 없어 지금은 'operator' 고정이다(spec operation 02 §8). */
  by: string;
}

/** 판정과 그 이력이 붙은 레코드. spec system 03 §6.1 + spec operation 02 §5 */
export interface OutcomeFields {
  outcome?: Outcome;
  resolvedAt?: number;
  resolvedBy?: string;
  outcomeHistory?: OutcomeChange[];
  /** 부분 파기된 필드 이름. 파기 사실이 남아야 "원래 없었다"와 구분된다. */
  purged?: string[];
  purgedAt?: number;
}

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

export function isJudgment(value: unknown): value is Judgment {
  return typeof value === 'string' && (JUDGMENTS as readonly string[]).includes(value);
}

/** 없으면 `detected`. 이 정책 이전에 쌓인 레코드가 그렇다. */
export function outcomeOf(record: OutcomeFields | null | undefined): Outcome {
  return isOutcome(record?.outcome) ? record.outcome : DETECTED;
}

/** 사건 사본이 있어야 하는 상태인가. 오직 `confirmed`뿐이다. */
export function isIncident(record: OutcomeFields | null | undefined): boolean {
  return outcomeOf(record) === CONFIRMED;
}

/**
 * 번복 창의 마감 시각. 아직 판정이 없으면 null.
 *
 * 기준점이 `resolvedAt`이지 감지 시각이 아니다. 관제사가 12시간 뒤에 봤다면 그때부터
 * 24시간을 준다 — 늦게 본 것이 번복할 시간을 깎을 이유가 없다.
 */
export function undoDeadline(record: OutcomeFields, undoWindowMs: number): number | null {
  const at = record.resolvedAt;
  return Number.isFinite(at as number) ? (at as number) + undoWindowMs : null;
}

export interface TransitionResult {
  ok: boolean;
  /** 막혔을 때 사람이 읽는 사유. ok면 빈 문자열 */
  reason: string;
  /** ok일 때 레코드에 덮어쓸 필드. 호출부가 이걸 합쳐 저장한다. */
  patch?: OutcomeFields;
}

/**
 * 판정을 적용할 수 있는지 보고, 되면 덮어쓸 필드를 돌려준다.
 *
 * 규칙은 둘뿐이다.
 *  - `detected`에서 판정으로 가는 것은 **언제든** 된다. 아직 판단이 없던 상태다.
 *  - `confirmed`↔`false_alarm` 번복은 **번복 창 안에서만** 된다.
 *
 * 번복에 창을 두는 이유는 그것이 사건 사본을 만들거나 지우기 때문이다. 창을 무한정
 * 열어두면 3년짜리 사고 기록이 언제든 사라질 수 있게 된다.
 */
export function applyJudgment(
  record: OutcomeFields,
  next: Judgment,
  by: string,
  at: number,
  undoWindowMs: number,
): TransitionResult {
  const from = outcomeOf(record);
  if (from === next) return { ok: false, reason: `이미 ${next}다` };

  if (from === CONFIRMED || from === FALSE_ALARM) {
    const deadline = undoDeadline(record, undoWindowMs);
    if (deadline === null) {
      // 판정은 있는데 시각이 없다. 옛 레코드이거나 파일이 손상됐다.
      return { ok: false, reason: '판정 시각이 없어 번복 창을 계산할 수 없다' };
    }
    if (at > deadline) {
      const hours = Math.round(undoWindowMs / 3_600_000);
      return { ok: false, reason: `번복 창 ${hours}시간이 지났다` };
    }
  }

  const history = Array.isArray(record.outcomeHistory) ? [...record.outcomeHistory] : [];
  history.push({ at, from, to: next, by });
  return {
    ok: true,
    reason: '',
    patch: { outcome: next, resolvedAt: at, resolvedBy: by, outcomeHistory: history },
  };
}

/**
 * 판정 전이면 사건 사본이 있어야 하는가. `applyJudgment` 결과와 함께 호출부가 본다.
 */
export function wantsIncident(outcome: Outcome): boolean {
  return outcome === CONFIRMED;
}
