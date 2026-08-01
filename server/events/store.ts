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
}

export interface EventStore {
  save(record: EventRecord): void;
  read(eventId: string): EventRecord | null;
  list(limit?: number): EventSummary[];
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
    const file = path.join(folder, RECORD_FILE);
    // 임시 파일에 다 쓰고 나서 이름을 바꾼다. 쓰는 중에 목록 요청이 들어와도
    // 반쪽짜리 JSON을 읽는 일이 없다.
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  }

  function read(eventId: string): EventRecord | null {
    if (!isValidEventId(eventId)) return null;
    return readFile(path.join(dir, eventId, RECORD_FILE));
  }

  function list(limit: number = DEFAULT_EVENT_LIST_LIMIT): EventSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return []; // 아직 이벤트가 한 건도 없다 — 폴더가 없는 게 정상이다
    }

    // 전부 열어보고 정렬하면 이벤트가 쌓일수록 목록이 느려진다. 파일 시각으로 먼저 추리고
    // 필요한 것만 파싱한다.
    const candidates = names
      .filter((name) => isValidEventId(name))
      .map((name) => {
        const file = path.join(dir, name, RECORD_FILE);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
          return null; // 레코드가 아직 없거나 읽는 사이에 지워졌다
        }
        return { file, mtimeMs };
      })
      .filter((entry): entry is { file: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(0, limit));

    return candidates
      .map((entry) => readFile(entry.file))
      .filter((record): record is EventRecord => record !== null)
      .map(summarize)
      // 파일 시각이 아니라 사고 시각 기준으로 최신순. 둘은 대개 같지만 첨부가 붙어
      // 파일이 다시 써지면(R-4) 어긋난다.
      .sort((a, b) => b.ts - a.ts);
  }

  return { save, read, list, dir, eventDir };
}

export function summarize(record: EventRecord): EventSummary {
  const alert = (record.alert ?? {}) as Record<string, unknown>;
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
    attachmentCount: record.attachments?.length ?? 0,
  };
}

function readFile(file: string): EventRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EventRecord;
    return typeof parsed?.eventId === 'string' ? parsed : null;
  } catch {
    return null; // 깨진 파일 하나가 목록 전체를 못 쓰게 만들지 않는다
  }
}
