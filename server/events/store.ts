// 이벤트 레코드 파일 저장소(spec 03 §6.1, R-1). **이벤트 하나가 폴더 하나다.**
//
//   <dir>/<eventId>/record.json   경보 + 전후 궤적·가속도
//   <dir>/<eventId>/att-*.mp4     현장 영상(R-2)
//   <dir>/<eventId>/att-*.ply     재구성 산출물(R-3·R-4)
//   <dir>/<eventId>/recon/        재구성 작업 폴더(프레임·COLMAP sparse·로그)
//
// DB를 두지 않는 이유: 레코드는 한 번 쓰고 거의 안 고친다(첨부가 붙을 때만 다시 쓴다).
// 질의가 필요 없고, 파일이면 데모 중에 그냥 열어볼 수 있다. 사고 하나에 관한 것이
// 폴더 하나에 모여 있어 반출·삭제도 폴더 단위로 끝난다.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EventRecord } from './recorder.ts';
import { outcomeOf, type Outcome } from './outcome.ts';

/** 목록 응답 한 줄. 궤적·가속도 배열은 빼고 세기만 준다 — 목록이 수 MB가 되면 못 쓴다. */
export interface EventSummary {
  eventId: string;
  tagId: string;
  ts: number;
  type: unknown;
  peakAccel: unknown;
  freefall: unknown;
  aiScore: unknown;
  zone: unknown;
  pos: unknown;
  trackCount: number;
  accelCount: number;
  attachmentCount: number;
  /** 관제사 판정(spec 11 §3). 좌측 3D 탭이 이걸로 사건을 가른다. */
  outcome: Outcome;
  resolvedAt?: number;
  /** 재구성 산출물이 붙었는가. 3D 탭이 "3D 없음"을 표시하는 근거다. */
  hasSplat: boolean;
  /** 부분 파기된 필드. 좌표가 지워진 건은 궤적을 못 그린다. */
  purged?: string[];
}

export interface EventStore {
  save(record: EventRecord): void;
  read(eventId: string): EventRecord | null;
  list(limit?: number): EventSummary[];
  /** 레코드를 읽고-고쳐-쓴다. **중간에 await가 없어야** 겹친 갱신이 서로를 덮어쓰지 않는다. */
  patch(eventId: string, fields: Partial<EventRecord>): EventRecord | null;
  /** 폴더째 지운다(spec 11 §7). 없던 이벤트면 false. */
  remove(eventId: string): boolean;
  /** 이 이벤트의 폴더 절대 경로. 첨부·재구성 산출물이 전부 여기 들어간다. */
  eventDir(eventId: string): string;
  dir: string;
}

export const DEFAULT_EVENT_LIST_LIMIT = 100;

/**
 * eventId는 그대로 파일 이름이 된다. `..`이나 슬래시가 섞이면 저장소 밖을 가리키게 되므로
 * 여기서 막는다. 발급 형식은 `evt-<tagId>-<ts>-<seq>`이고(detection/fall.ts), tagId까지
 * 이 문자 집합 안에 있다.
 */
const SAFE_EVENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidEventId(eventId: unknown): eventId is string {
  return typeof eventId === 'string' && SAFE_EVENT_ID.test(eventId) && !eventId.includes('..');
}

export const RECORD_FILE = 'record.json';

/**
 * 요약 캐시. 목록이 레코드 전문을 파싱하지 않게 한다.
 *
 * 레코드 하나가 50KB(궤적 226점 + 가속도 226점)라, 100건이면 목록 한 번에 5MB를 파싱한다.
 * 필요한 건 개수뿐인데. 이 파일은 200바이트쯤이고 레코드를 쓸 때마다 같이 쓴다.
 * 없거나 깨졌으면 레코드에서 다시 만든다 — 캐시라 없어도 동작은 같다.
 */
export const SUMMARY_FILE = 'summary.json';

export function createEventStore(dir: string): EventStore {
  function eventDir(eventId: string): string {
    if (!isValidEventId(eventId)) {
      throw new Error(`폴더 이름으로 쓸 수 없는 eventId: ${String(eventId)}`);
    }
    return path.join(dir, eventId);
  }

  function save(record: EventRecord): void {
    const folder = eventDir(record.eventId);
    fs.mkdirSync(folder, { recursive: true });
    writeAtomic(path.join(folder, RECORD_FILE), record);
    // 요약을 레코드보다 **나중에** 쓴다. 중간에 죽으면 요약이 옛것으로 남는데,
    // 그 반대(요약만 새것)보다 낫다 — 목록이 아직 없는 첨부를 세는 일이 없다.
    writeAtomic(path.join(folder, SUMMARY_FILE), summarize(record));
  }

  function read(eventId: string): EventRecord | null {
    if (!isValidEventId(eventId)) return null;
    return readJson<EventRecord>(path.join(dir, eventId, RECORD_FILE), (v) => typeof v?.eventId === 'string');
  }

  function patch(eventId: string, fields: Partial<EventRecord>): EventRecord | null {
    // 읽고-고쳐-쓰기 사이에 await가 없다. 판정 갱신과 재구성 상태 갱신이 겹쳐도
    // 한쪽이 다른 쪽을 덮어쓰지 않게 하는 유일한 장치다(attachments.ts와 같은 규칙).
    const record = read(eventId);
    if (!record) return null;
    const next = { ...record, ...fields };
    save(next);
    return next;
  }

  function remove(eventId: string): boolean {
    if (!isValidEventId(eventId)) return false;
    const folder = path.join(dir, eventId);
    if (!fs.existsSync(folder)) return false;
    // 재귀 삭제다. 첨부·재구성 작업물이 전부 이 안에 있어 폴더 하나로 파기가 끝난다
    // (개인정보보호법 제21조② "복구 또는 재생되지 아니하도록").
    fs.rmSync(folder, { recursive: true, force: true });
    return true;
  }

  function list(limit: number = DEFAULT_EVENT_LIST_LIMIT): EventSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return []; // 아직 이벤트가 한 건도 없다 — 폴더가 없는 게 정상이다
    }

    // 전부 열어보고 정렬하면 이벤트가 쌓일수록 목록이 느려진다. 파일 시각으로 먼저 추리고
    // 필요한 것만 읽는다.
    const candidates = names
      .filter((name) => isValidEventId(name))
      .map((name) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(dir, name, RECORD_FILE)).mtimeMs;
        } catch {
          return null; // 레코드가 아직 없거나 읽는 사이에 지워졌다
        }
        return { name, mtimeMs };
      })
      .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(0, limit));

    return candidates
      .map((entry) => summaryOf(entry.name))
      .filter((summary): summary is EventSummary => summary !== null)
      // 파일 시각이 아니라 사고 시각 기준으로 최신순. 둘은 대개 같지만 첨부가 붙어
      // 파일이 다시 써지면(R-4) 어긋난다.
      .sort((a, b) => b.ts - a.ts);
  }

  /** 캐시를 먼저 보고, 없거나 깨졌으면 레코드에서 만든다. */
  function summaryOf(name: string): EventSummary | null {
    const cached = readJson<EventSummary>(
      path.join(dir, name, SUMMARY_FILE),
      (v) => typeof v?.eventId === 'string' && typeof v?.outcome === 'string',
    );
    if (cached) return cached;

    const record = read(name);
    if (!record) return null;
    const summary = summarize(record);
    // 다음 목록 요청이 다시 전문을 파싱하지 않도록 여기서 채워 둔다.
    try {
      writeAtomic(path.join(dir, name, SUMMARY_FILE), summary);
    } catch { /* 캐시를 못 써도 목록은 나가야 한다 */ }
    return summary;
  }

  return { save, read, patch, remove, list, dir, eventDir };
}

export function summarize(record: EventRecord): EventSummary {
  const alert = (record.alert ?? {}) as Record<string, unknown>;
  const attachments = Array.isArray(record.attachments) ? record.attachments : [];
  const purged = Array.isArray(record.purged) ? record.purged : undefined;
  return {
    eventId: record.eventId,
    tagId: record.tagId,
    ts: record.ts,
    type: alert.type,
    peakAccel: alert.peakAccel,
    freefall: alert.freefall,
    aiScore: alert.aiScore,
    zone: alert.zone,
    pos: alert.pos,
    trackCount: record.track?.length ?? 0,
    accelCount: record.accel?.length ?? 0,
    attachmentCount: attachments.length,
    outcome: outcomeOf(record),
    ...(Number.isFinite(record.resolvedAt as number) ? { resolvedAt: record.resolvedAt } : {}),
    hasSplat: attachments.some((a) => (a as { kind?: unknown })?.kind === 'splat'),
    ...(purged && purged.length > 0 ? { purged } : {}),
  };
}

/** 임시 파일에 다 쓰고 이름을 바꾼다. 쓰는 중에 읽어도 반쪽짜리 JSON을 보는 일이 없다. */
function writeAtomic(file: string, value: unknown): void {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function readJson<T>(file: string, valid: (value: T) => boolean): T | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    return valid(parsed) ? parsed : null;
  } catch {
    return null; // 깨진 파일 하나가 목록 전체를 못 쓰게 만들지 않는다
  }
}
