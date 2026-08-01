// 낙상 이벤트 기록기 — 경보 전후의 궤적·가속도를 모아 한 레코드로 닫는다(spec 03 §6.1, R-1).
//
// 서버는 지금까지 alert를 SSE로 뿌린 뒤 버렸다. 사고 현장 3D 기록(R-2~R-5)이 붙을 대상이
// 없다는 뜻이라, 붙일 몸통을 먼저 만든다.
//
// 두 가지가 이 모듈의 전부다.
//  1) 태그마다 최근 프레임을 링버퍼에 담아둔다 — 경보는 항상 사후에 오므로 미리 갖고 있어야 한다.
//  2) 경보가 오면 그 시각 전후 창이 찰 때까지 기다렸다가 닫는다.
//
// 파일 쓰기는 하지 않는다. 닫힌 레코드를 onRecord로 넘길 뿐이고, 어디에 어떻게 남기는지는
// store.ts가 쥔다.

export interface TrackPoint {
  ts: number;
  x: number;
  y: number;
}

export interface AccelSample {
  ts: number;
  x: number;
  y: number;
  z: number;
}

export interface EventRecord {
  eventId: string;
  tagId: string;
  /** 충격이 일어난 시각. 경보의 ts를 그대로 쓴다(spec 03 §2). */
  ts: number;
  /** 경보 원본 그대로. 스키마는 spec 03 §2. */
  alert: Record<string, unknown>;
  track: TrackPoint[];
  accel: AccelSample[];
  /** R-2~R-4가 채운다. 기록 시점에는 항상 빈 배열이다. */
  attachments: unknown[];
}

export interface RecorderConfig {
  /** 경보 시각 이전으로 담을 구간(ms). 접근 동선이 보이는 길이. */
  preWindowMs: number;
  /** 경보 시각 이후로 담을 구간(ms). 넘어진 뒤 정지가 보이는 길이. */
  postWindowMs: number;
  /**
   * 프레임이 끊겨도 기록을 닫는 벽시계 여유(ms).
   * 클립 주입은 몇 초짜리라 재생이 끝나면 그 태그의 ingest가 아예 멎는다. 데이터로만
   * 창이 찬 걸 판정하면 그런 기록은 영영 안 닫힌다.
   */
  flushGraceMs: number;
}

export const RECORDER_DEFAULTS: RecorderConfig = {
  preWindowMs: 10_000,
  postWindowMs: 10_000,
  flushGraceMs: 2_000,
};

export type RecorderOptions = Partial<RecorderConfig> & {
  onRecord: (record: EventRecord) => void;
  /** onRecord가 던졌을 때. 타이머 안에서도 불리므로 여기서 막지 않으면 서버가 죽는다. */
  onError?: (error: unknown, record: EventRecord) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (timer: unknown) => void;
};

/**
 * 기록에 필요한 최소 필드. detection/fall.ts의 경보가 이 모양을 만족한다.
 * 나머지 필드는 그대로 통째로 실린다 — 여기 안 적혀 있다고 버려지지 않는다.
 */
export type RecordableAlert = {
  eventId?: unknown;
  tagId?: unknown;
  ts?: unknown;
};

interface TagBuffer {
  track: TrackPoint[];
  accel: AccelSample[];
  /** 도착 순서가 아니라 관측된 가장 늦은 시각. 프레임 순서는 뒤집힐 수 있다. */
  maxTs: number;
}

interface Pending {
  eventId: string;
  tagId: string;
  ts: number;
  alert: Record<string, unknown>;
  timer: unknown;
}

export interface EventRecorder {
  /** ingest 프레임 하나를 링버퍼에 넣고, 창이 찬 기록이 있으면 닫는다. */
  observe(payload: unknown, position?: unknown): void;
  /** 경보 하나를 기록 대상으로 등록한다. 실제로 닫히는 건 post 창이 찬 뒤다. */
  record(alert: RecordableAlert): boolean;
  /** 태그의 버퍼를 비운다. 대기 중인 기록은 있는 만큼으로 먼저 닫는다. */
  reset(tagId: string): void;
  /** 대기 중인 기록을 전부 지금 닫는다(종료·테스트용). */
  flushAll(): void;
  pendingCount(): number;
  /** 링버퍼에 남아 있는 표본 수. 오래 돌 때 버퍼가 자라지 않는지 보는 창구다. */
  bufferedCount(tagId: string): { track: number; accel: number };
}

export function createEventRecorder(options: RecorderOptions): EventRecorder {
  const cfg: RecorderConfig = { ...RECORDER_DEFAULTS, ...stripUndefined(options) };
  validateConfig(cfg);

  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const cancelSchedule = options.cancelSchedule
    ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const onError = options.onError
    ?? ((error: unknown, record: EventRecord) => {
      console.error(`[event] ${record.eventId} 기록 실패`, error);
    });

  // 링버퍼가 쥐고 있어야 하는 길이. pre + post면 충분하다 — post 창이 안 찬 기록만 대기하므로
  // 대기 중인 경보는 늦어도 (가장 늦은 시각 - post) 이후에 있고, 그 pre 창의 시작은
  // (가장 늦은 시각 - post - pre) 이후다. 딱 이 만큼만 남기면 잘려나가는 표본이 없다.
  const retentionMs = cfg.preWindowMs + cfg.postWindowMs;

  const buffers = new Map<string, TagBuffer>();
  const pending: Pending[] = [];

  function bufferFor(tagId: string): TagBuffer {
    let buffer = buffers.get(tagId);
    if (!buffer) {
      buffer = { track: [], accel: [], maxTs: Number.NEGATIVE_INFINITY };
      buffers.set(tagId, buffer);
    }
    return buffer;
  }

  function observe(payload: unknown, position?: unknown): void {
    const frame = payload as { tagId?: unknown; ts?: unknown; accel?: unknown } | null;
    if (!frame || typeof frame.tagId !== 'string' || !frame.tagId) return;
    if (!Number.isFinite(frame.ts as number)) return;

    const ts = frame.ts as number;
    const buffer = bufferFor(frame.tagId);
    if (ts > buffer.maxTs) buffer.maxTs = ts;

    const accel = frame.accel as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (accel && isFiniteTriple(accel)) {
      buffer.accel.push({ ts, x: accel.x as number, y: accel.y as number, z: accel.z as number });
    }

    // 좌표는 스무딩을 거친 값이다. 삼각측량이 보류된 프레임(accel-only)은 궤적에 안 남는다 —
    // 없는 위치를 지어내지 않고, 화면에서도 그 구간이 비어 보이는 게 맞다.
    const pos = (position as { pos?: { x?: unknown; y?: unknown } } | null | undefined)?.pos;
    if (pos && Number.isFinite(pos.x as number) && Number.isFinite(pos.y as number)) {
      buffer.track.push({ ts, x: pos.x as number, y: pos.y as number });
    }

    prune(buffer);
    flushMatured(frame.tagId, buffer.maxTs);
  }

  function prune(buffer: TagBuffer): void {
    const cutoff = buffer.maxTs - retentionMs;
    dropOlderThan(buffer.track, cutoff);
    dropOlderThan(buffer.accel, cutoff);
  }

  function record(alert: RecordableAlert): boolean {
    if (!alert || typeof alert.eventId !== 'string' || !alert.eventId) return false;
    if (typeof alert.tagId !== 'string' || !alert.tagId) return false;
    if (!Number.isFinite(alert.ts as number)) return false;
    if (pending.some((entry) => entry.eventId === alert.eventId)) return false;

    const entry: Pending = {
      eventId: alert.eventId,
      tagId: alert.tagId,
      ts: alert.ts as number,
      // 경보 객체는 서버가 zone을 채운 뒤에도 계속 살아 있다. 얕은 복사로 그 시점을 굳힌다.
      alert: { ...alert },
      timer: null,
    };
    pending.push(entry);

    // 데이터로 창이 차면 그때 닫히고, 프레임이 멎으면 이 타이머가 닫는다. 둘 중 먼저 오는 쪽.
    entry.timer = schedule(() => finalize(entry), cfg.postWindowMs + cfg.flushGraceMs);
    return true;
  }

  function flushMatured(tagId: string, maxTs: number): void {
    // finalize가 pending을 건드리므로 사본을 돌린다.
    for (const entry of [...pending]) {
      if (entry.tagId !== tagId) continue;
      if (maxTs >= entry.ts + cfg.postWindowMs) finalize(entry);
    }
  }

  function finalize(entry: Pending): void {
    const index = pending.indexOf(entry);
    if (index < 0) return; // 이미 닫혔다 — 타이머와 데이터가 겹친 경우
    pending.splice(index, 1);
    if (entry.timer !== null) cancelSchedule(entry.timer);

    const buffer = buffers.get(entry.tagId);
    const from = entry.ts - cfg.preWindowMs;
    const to = entry.ts + cfg.postWindowMs;
    const record: EventRecord = {
      eventId: entry.eventId,
      tagId: entry.tagId,
      ts: entry.ts,
      alert: entry.alert,
      track: sliceWindow(buffer?.track ?? [], from, to),
      accel: sliceWindow(buffer?.accel ?? [], from, to),
      attachments: [],
    };

    try {
      options.onRecord(record);
    } catch (error: unknown) {
      onError(error, record);
    }
  }

  function reset(tagId: string): void {
    for (const entry of [...pending]) {
      if (entry.tagId === tagId) finalize(entry);
    }
    buffers.delete(tagId);
  }

  function flushAll(): void {
    for (const entry of [...pending]) finalize(entry);
  }

  function bufferedCount(tagId: string): { track: number; accel: number } {
    const buffer = buffers.get(tagId);
    return { track: buffer?.track.length ?? 0, accel: buffer?.accel.length ?? 0 };
  }

  return { observe, record, reset, flushAll, pendingCount: () => pending.length, bufferedCount };
}

export function recorderOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Partial<RecorderConfig> {
  return {
    preWindowMs: num(env, 'EVENT_PRE_MS', RECORDER_DEFAULTS.preWindowMs),
    postWindowMs: num(env, 'EVENT_POST_MS', RECORDER_DEFAULTS.postWindowMs),
  };
}

/** 프레임이 안 멎어도 프로세스가 끝나면 같이 끝나야 한다 — 대기 타이머가 서버를 붙잡지 않게. */
function defaultSchedule(callback: () => void, delayMs: number): unknown {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

function dropOlderThan(samples: { ts: number }[], cutoff: number): void {
  let drop = 0;
  while (drop < samples.length && samples[drop].ts < cutoff) drop += 1;
  if (drop > 0) samples.splice(0, drop);
}

/**
 * 창 안의 표본만 시각 순으로 돌려준다. 프레임당 POST 1건이라 도착 순서가 뒤집히는데,
 * 그대로 두면 R-5의 파형이 앞뒤로 튄다.
 */
function sliceWindow<T extends { ts: number }>(samples: readonly T[], from: number, to: number): T[] {
  return samples.filter((sample) => sample.ts >= from && sample.ts <= to)
    .sort((a, b) => a.ts - b.ts);
}

function isFiniteTriple(value: { x?: unknown; y?: unknown; z?: unknown }): boolean {
  return Number.isFinite(value.x as number)
    && Number.isFinite(value.y as number)
    && Number.isFinite(value.z as number);
}

function stripUndefined(options: RecorderOptions): Partial<RecorderConfig> {
  const picked: Partial<RecorderConfig> = {};
  for (const key of ['preWindowMs', 'postWindowMs', 'flushGraceMs'] as const) {
    if (options[key] !== undefined) picked[key] = options[key];
  }
  return picked;
}

function validateConfig(cfg: RecorderConfig): void {
  for (const key of ['preWindowMs', 'postWindowMs', 'flushGraceMs'] as const) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 0) {
      throw new Error(`${key}는 0 이상의 유한한 수여야 합니다: ${cfg[key]}`);
    }
  }
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
