// 보관기간 파기 엔진(spec operation 02 §7).
//
// **파기는 자동이 기본이다.** 법이 "즉시"(위치정보법 제23조①)와 "지체 없이"(개인정보보호법
// 제21조①)를 요구하는데 사람 손에 맡기면 안 지켜진다. 수동 삭제는 조기 파기용 보조다.
//
// 기동 시 한 번 훑고 그 뒤로 하루에 한 번 돈다. 무엇을 지웠는지는 7층 확인자료에 남긴다 —
// 파기 자체가 기록해야 하는 처리 행위다.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EventStore } from './store.ts';
import type { AuditLog } from '../lib/audit.ts';


export interface RetentionConfig {
  /** 번복 창 = 감지 이벤트 수명(spec operation 02 §3). */
  undoWindowMs: number;
  /** 확인 사건 보관. 민법 제766조① 소멸시효 3년. */
  incidentRetentionMs: number;
  /** 자동 파기 주기. */
  sweepIntervalMs: number;
  /** 켜면 지우지 않고 무엇을 지울지만 돌려준다. 정책을 바꿔 볼 때 쓴다. */
  dryRun: boolean;
  /** 시설 자산으로 넘긴 촬영물이 들어가는 자리(spec operation 02 §4.4). */
  facilityDir: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** setInterval이 받을 수 있는 최대(2^31-1 ≈ 24.8일). 넘기면 1ms로 접힌다. */
export const MAX_TIMER_MS = 2_147_483_647;

export const RETENTION_DEFAULTS: RetentionConfig = {
  undoWindowMs: 24 * HOUR_MS,
  incidentRetentionMs: 1095 * DAY_MS, // 3년
  sweepIntervalMs: 24 * HOUR_MS,
  dryRun: false,
  facilityDir: '',
};

/** 무엇을 왜 했는지. 로그와 응답에 같이 쓴다. */
export interface RetentionAction {
  eventId: string;
  action: 'purge-workdir' | 'facility-transfer' | 'delete';
  reason: string;
  /** 회수한 바이트. 셀 수 없으면 0. */
  bytes: number;
}

export interface Retention {
  /** 한 바퀴 돈다. 무엇을 했는지 돌려준다. */
  sweep(now?: number): RetentionAction[];
  /** 재구성 중간물만 지운다. 사건과 산출물은 그대로 둔다. */
  purgeWorkdir(eventId: string): RetentionAction[];
  /** 기동 시 1회 + 주기 실행을 건다. */
  start(): void;
  stop(): void;
  config: RetentionConfig;
}

export interface RetentionOptions extends Partial<RetentionConfig> {
  /** 감지 이벤트 저장소. 24시간짜리 운영 로그다. */
  store: EventStore;
  /** 확인 사건 저장소. 이벤트의 사본이고 3년 산다. 첨부도 여기 붙는다. */
  incidents: EventStore;
  audit: AuditLog;
  now?: () => number;
  onLog?: (line: string) => void;
}

/**
 * 재구성이 끝나면 쓸모가 없어지는 것들. 실측으로 한 건에 313MB였다
 * (database.db 229 + frames 43 + project 41).
 *
 * **`scene.ply`는 여기 없다.** 러너가 산출물을 이벤트 폴더 루트로 옮기지 않고
 * 작업 폴더 안의 그 자리를 첨부로 등록한다(attachments.ts의 attachLocalFile — 이미
 * 이벤트 폴더 안이면 옮기지 않는다). 즉 `recon/<attId>/scene.ply`가 사본이 아니라
 * **산출물 본체**다. 사본인 줄 알고 목록에 넣었다가 실제 재구성 결과 2건(158MB·183MB)을
 * 지웠다. 아래 `referenced()`가 같은 실수를 구조로 막는다.
 */
const WORKDIR_SPENT = ['database.db', 'frames', 'project'] as const;

/**
 * 시설 자산으로 넘길 수 있는 첨부. 사고 현장 촬영물이고, 사건과의 연결을 끊으면
 * 어느 구역의 기록인지만 남는다. **촬영 지침이 전제다** — 대상자가 이송된 뒤 빈 현장을
 * 찍는다(spec operation 02 §4.4). 사람이 담긴 영상은 이 길을 탈 수 없다.
 */
const TRANSFERABLE = ['splat', 'video'] as const;

export function createRetention(options: RetentionOptions): Retention {
  const config: RetentionConfig = { ...RETENTION_DEFAULTS, ...stripUndefined(options) };
  const { store, incidents, audit } = options;
  const now = options.now ?? Date.now;
  const log = options.onLog ?? ((line: string) => console.log(line));
  let timer: NodeJS.Timeout | null = null;

  function sweep(at: number = now()): RetentionAction[] {
    const done: RetentionAction[] = [];

    // ① 감지 이벤트는 판정 여부와 무관하게 24시간이면 사라진다.
    //    판정이 confirmed였다면 그 사본이 사건 저장소에 이미 있으므로 잃는 것이 없다.
    for (const summary of store.list(Number.MAX_SAFE_INTEGER)) {
      if (at <= summary.ts + config.undoWindowMs) continue;
      done.push(...deleteRecord(store, summary.eventId, '감지 이벤트 보관기간 경과', at, false));
    }

    // ② 확인 사건은 3년. 지울 때 현장 촬영물을 시설 자산으로 넘긴다.
    for (const summary of incidents.list(Number.MAX_SAFE_INTEGER)) {
      if (at > summary.ts + config.incidentRetentionMs) {
        done.push(...deleteRecord(incidents, summary.eventId, '사건 보관기간 경과', at, true));
        continue;
      }
      // ③ 살아남은 사건의 재구성 찌꺼기를 훑는다. 러너가 성공 직후 지우지만,
      //    중간에 죽은 실행분이 여기서 걸린다.
      done.push(...purgeWorkdir(summary.eventId));
    }

    if (done.length > 0) {
      const bytes = done.reduce((sum, a) => sum + a.bytes, 0);
      log(`[retention] ${done.length}건 처리${config.dryRun ? '(dry-run)' : ''}`
        + `${bytes > 0 ? ` · ${mb(bytes)}MB 회수` : ''}`);
    }
    return done;
  }

  /** 폴더째 지운다. `transfer`면 지우기 전에 촬영물을 시설 자산으로 넘긴다. */
  function deleteRecord(
    from: EventStore,
    id: string,
    reason: string,
    at: number,
    transfer: boolean,
  ): RetentionAction[] {
    const done: RetentionAction[] = [];
    const record = from.read(id);
    if (transfer && config.facilityDir) done.push(...transferAssets(from, id, at));

    const bytes = dirBytes(from.eventDir(id));
    if (!config.dryRun) {
      from.remove(id);
      audit.record({
        at,
        kind: 'access',
        ...(record?.tagId ? { tagId: record.tagId } : {}),
        actor: 'system',
        detail: `${id} 파기 · ${reason}`,
      });
    }
    done.push({ eventId: id, action: 'delete', reason, bytes });
    return done;
  }

  /**
   * `.ply`를 시설 자산으로 옮긴다(spec 11 §4.4).
   *
   * **연결을 전부 끊는 것이 이 함수의 전부다.** eventId·attachmentId·원본 파일명·촬영 시각을
   * 하나라도 남기면 제2조 제1호 나목의 "쉽게 결합"이 되살아나 제21조 제3항의 분리가 무효다.
   * 남는 것은 어느 구역의 3D인지뿐이고, 장소는 개인 식별 정보가 아니다.
   */
  function transferAssets(from: EventStore, eventId: string, at: number): RetentionAction[] {
    const record = from.read(eventId);
    const attachments = Array.isArray(record?.attachments) ? record.attachments : [];
    const movable = attachments.filter((a) => TRANSFERABLE.includes((a as { kind?: string })?.kind as never));
    if (movable.length === 0) return [];

    const zone = slug(String((record?.alert as { zone?: unknown })?.zone ?? '')) || 'unknown';
    const target = path.join(config.facilityDir, zone);
    const done: RetentionAction[] = [];

    for (const raw of movable) {
      const attachment = raw as { path?: unknown; kind?: string };
      if (typeof attachment.path !== 'string') continue;
      const source = path.join(from.eventDir(eventId), attachment.path);
      let bytes = 0;
      try {
        bytes = fs.statSync(source).size;
      } catch {
        continue; // 레코드에는 있는데 파일이 없다
      }
      const kind = attachment.kind === 'splat' ? '3D 산출물' : '현장 영상';
      if (config.dryRun) {
        done.push({ eventId, action: 'facility-transfer', reason: `${kind} → ${zone}`, bytes });
        continue;
      }
      try {
        fs.mkdirSync(target, { recursive: true });
        // 이름도 새로 짓는다. 원본 이름을 쓰면 attachmentId가 그대로 따라간다.
        const ext = attachment.kind === 'splat' ? 'ply' : (attachment.path.split('.').pop() || 'mov');
        const to = path.join(target, `${zone}-${nextIndex(target, ext)}.${ext}`);
        fs.renameSync(source, to);
        done.push({ eventId, action: 'facility-transfer', reason: `${kind} → ${zone}`, bytes });
        audit.record({
          at,
          kind: 'access',
          actor: 'system',
          detail: `${kind}을 시설 자산으로 이관 · ${zone} · 사건 연결 해제`,
        });
      } catch (error: unknown) {
        log(`[retention] ⚠ 자산 이관 실패 ${eventId} — ${describe(error)}`);
      }
    }
    return done;
  }

  /**
   * 재구성 작업 폴더에서 다 쓴 것만 지운다. `recon.log`와 `cameras.json`은 남긴다 —
   * 어떤 설정이 어떤 결과를 냈는지 대조하는 근거이고 합쳐서 1MB 미만이다.
   *
   * **실패한 건은 건드리지 않는다.** 원인 추적이 아직 목적이라 목적 달성이 아니다.
   */
  function purgeWorkdir(eventId: string): RetentionAction[] {
    const record = incidents.read(eventId);
    const attachments = Array.isArray(record?.attachments) ? record.attachments : [];
    const done: RetentionAction[] = [];

    // **레코드가 첨부로 가리키는 파일은 무엇이든 건드리지 않는다.** 산출물이 작업 폴더
    // 안에 그대로 등록되기 때문에(위 WORKDIR_SPENT 주석), 이름만 보고 지우면 결과물이
    // 날아간다. 목록을 늘릴 때 실수해도 이 가드가 막는다.
    const folder = incidents.eventDir(eventId);
    const referenced = new Set(
      attachments
        .map((a) => (a as { path?: unknown }).path)
        .filter((p): p is string => typeof p === 'string')
        .map((p) => path.resolve(folder, p)),
    );
    const keeps = (target: string): boolean => {
      const full = path.resolve(target);
      for (const file of referenced) {
        // 파일 자체거나, 그 파일을 품고 있는 폴더면 못 지운다.
        if (file === full || file.startsWith(`${full}${path.sep}`)) return true;
      }
      return false;
    };

    for (const raw of attachments) {
      const attachment = raw as { attachmentId?: unknown; recon?: { status?: unknown } };
      if (typeof attachment.attachmentId !== 'string') continue;
      if (attachment.recon?.status !== 'done') continue;

      const workDir = path.join(folder, 'recon', attachment.attachmentId);
      let bytes = 0;
      for (const name of WORKDIR_SPENT) {
        const spent = path.join(workDir, name);
        if (!fs.existsSync(spent) || keeps(spent)) continue;
        bytes += dirBytes(spent);
        if (!config.dryRun) fs.rmSync(spent, { recursive: true, force: true });
      }
      if (bytes === 0) continue;

      done.push({
        eventId,
        action: 'purge-workdir',
        reason: `${attachment.attachmentId} 재구성 완료 · 중간물 파기`,
        bytes,
      });
      if (!config.dryRun) {
        audit.record({
          kind: 'access',
          actor: 'system',
          detail: `${eventId}/${attachment.attachmentId} 재구성 중간물 파기 · ${mb(bytes)}MB`,
        });
      }
    }
    return done;
  }

  function start(): void {
    if (timer) return;
    sweep(); // 기동 시 한 번. 서버가 꺼져 있던 사이에 만료된 것을 여기서 거둔다
    // setInterval은 32비트라 이 값을 넘기면 **1ms로 접혀** 파기가 초당 수백 번 돈다.
    // 자주 도는 것은 무해하므로 상한에서 자른다.
    timer = setInterval(() => sweep(), Math.min(config.sweepIntervalMs, MAX_TIMER_MS));
    timer.unref?.(); // 파기 타이머가 프로세스를 붙잡지 않게
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { sweep, purgeWorkdir, start, stop, config };
}

export function retentionOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Partial<RetentionConfig> {
  return {
    undoWindowMs: hours(env.UNDO_WINDOW_HOURS, RETENTION_DEFAULTS.undoWindowMs),
    incidentRetentionMs: days(env.INCIDENT_RETENTION_DAYS, RETENTION_DEFAULTS.incidentRetentionMs),
    sweepIntervalMs: hours(env.SWEEP_INTERVAL_HOURS, RETENTION_DEFAULTS.sweepIntervalMs),
    dryRun: env.RETENTION_DRY_RUN === '1',
  };
}

/** 파일 하나면 그 크기, 폴더면 안쪽 전부. 못 재면 0. */
function dirBytes(target: string): number {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(target).reduce((sum, name) => sum + dirBytes(path.join(target, name)), 0);
  } catch {
    return 0;
  }
}

/** 이미 있는 `<zone>-N.ply` 다음 번호. 순번 말고는 아무 정보도 안 담는다. */
function nextIndex(dir: string, ext: string): string {
  let count = 0;
  try {
    count = fs.readdirSync(dir).filter((name) => name.endsWith(`.${ext}`)).length;
  } catch { /* 아직 없는 폴더다 */ }
  return String(count + 1).padStart(2, '0');
}

/** 파일 이름으로 쓸 수 있는 구역 이름. 한글은 그대로 둔다 — 사람이 폴더를 열어 본다. */
function slug(zone: string): string {
  return zone.replace(/[^0-9A-Za-z가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function hours(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * HOUR_MS : fallback;
}

function days(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * DAY_MS : fallback;
}

function stripUndefined(options: RetentionOptions): Partial<RetentionConfig> {
  const picked: Partial<RetentionConfig> = {};
  for (const key of ['undoWindowMs', 'incidentRetentionMs', 'sweepIntervalMs', 'dryRun', 'facilityDir'] as const) {
    if (options[key] !== undefined) (picked as Record<string, unknown>)[key] = options[key];
  }
  return picked;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
