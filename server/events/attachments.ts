// 사고 기록 첨부(spec 03 §6.2, R-2~R-4). 현장 영상과 재구성 산출물을 이벤트에 붙인다.
//
// 파일은 이벤트 폴더 안에 들어가고, 메타는 record.json의 `attachments` 배열에 쌓인다.
// 레코드를 읽고-고쳐-쓰는 구간은 **중간에 await가 없다.** 업로드와 재구성 상태 갱신이
// 겹쳐도 한쪽이 다른 쪽을 덮어쓰지 않게 하는 유일한 장치라, 이 안에 비동기를 넣으면 깨진다.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import type { EventStore } from './store.ts';

export const ATTACHMENT_KINDS = ['video', 'photo', 'splat'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export type ReconStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ReconState {
  status: ReconStatus;
  /** 어떤 도구 조합으로 만들었는지. 나중에 결과를 비교할 때 이 값이 기준이 된다. */
  pipeline: string;
  /** 절대 스케일 확보용 기준물체 실측값(research 06 §1.2). 없으면 크기를 못 믿는다. */
  scaleRef?: { label: string; measuredMm: number };
  startedAt?: number;
  finishedAt?: number;
  /** 실패 사유 한 줄. 전문은 recon/<attachmentId>.log */
  error?: string;
  /** 산출물이 붙은 첨부의 id(kind=splat). 성공했을 때만 있다. */
  outputAttachmentId?: string;
}

export interface Attachment {
  attachmentId: string;
  eventId: string;
  kind: AttachmentKind;
  /** 이벤트 폴더 기준 상대 경로. 폴더째 옮겨도 안 깨진다. */
  path: string;
  bytes: number;
  /** 업로드된 원래 파일 이름. 화면 표시용이고 디스크 경로로는 절대 쓰지 않는다. */
  originalName?: string;
  /** 촬영 시각. 이벤트와 연결하는 근거가 이 값과 이벤트 ts의 관계다(spec 03 §6.2). */
  capturedAt: number;
  uploadedAt: number;
  recon?: ReconState;
  /** kind=splat일 때, 이 산출물을 만든 원본 영상의 attachmentId. */
  sourceAttachmentId?: string;
}

/** 확장자는 이 표 밖으로 안 나간다. 올라온 파일 이름을 그대로 쓰면 경로가 뚫린다. */
const EXTENSIONS: Record<AttachmentKind, readonly string[]> = {
  video: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'],
  photo: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'],
  splat: ['ply', 'splat', 'ksplat', 'spz'],
};

const DEFAULT_EXTENSION: Record<AttachmentKind, string> = {
  video: 'mp4',
  photo: 'jpg',
  splat: 'ply',
};

/** 60초 4K 폰 영상이 300MB 안팎이다. 그 두 배까지 받는다. */
export const DEFAULT_ATTACHMENT_LIMIT_BYTES = 600 * 1024 * 1024;

export class AttachmentError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'AttachmentError';
    this.statusCode = statusCode;
  }
}

export interface ReceiveMeta {
  kind: AttachmentKind;
  capturedAt?: number;
  originalName?: string;
  contentType?: string;
  scaleRef?: { label: string; measuredMm: number };
}

export interface AttachmentStore {
  /** 스트림을 받아 파일로 떨구고 레코드에 붙인다. 업로드 경로(R-2). */
  receive(eventId: string, meta: ReceiveMeta, source: Readable): Promise<Attachment>;
  /** 이미 디스크에 있는 파일을 첨부로 등록한다. 재구성 산출물 경로(R-4). */
  attachLocalFile(eventId: string, meta: ReceiveMeta & { sourceAttachmentId?: string }, absolutePath: string): Attachment;
  /** 재구성 상태 전이. pending → running → done|failed */
  patchRecon(eventId: string, attachmentId: string, patch: Partial<ReconState>): Attachment | null;
  get(eventId: string, attachmentId: string): Attachment | null;
  list(eventId: string): Attachment[];
  /** 첨부의 절대 경로. 파일을 실제로 읽거나 파이프라인에 넘길 때 쓴다. */
  absolutePathOf(attachment: Attachment): string;
}

export interface AttachmentStoreOptions {
  limitBytes?: number;
  now?: () => number;
}

export function createAttachmentStore(
  store: EventStore,
  options: AttachmentStoreOptions = {},
): AttachmentStore {
  const limitBytes = options.limitBytes ?? DEFAULT_ATTACHMENT_LIMIT_BYTES;
  const now = options.now ?? Date.now;

  function requireRecord(eventId: string) {
    const record = store.read(eventId);
    if (!record) throw new AttachmentError(`없는 이벤트: ${eventId}`, 404);
    return record;
  }

  async function receive(eventId: string, meta: ReceiveMeta, source: Readable): Promise<Attachment> {
    requireRecord(eventId); // 받기 전에 먼저 막는다 — 붙일 데가 없는 파일을 디스크에 안 남긴다
    const kind = validateKind(meta.kind);
    const folder = store.eventDir(eventId);
    fs.mkdirSync(folder, { recursive: true });

    const uploadedAt = now();
    const temp = path.join(folder, `.upload-${uploadedAt}.part`);
    let bytes = 0;

    const sink = fs.createWriteStream(temp);
    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            bytes += chunk.length;
            if (bytes > limitBytes) {
              throw new AttachmentError(`첨부가 ${limitBytes} 바이트를 넘었습니다`, 413);
            }
            yield chunk;
          }
        },
        sink,
      );
    } catch (error: unknown) {
      // 스트림이 완전히 닫힌 뒤에 지운다. 파괴가 비동기라 먼저 지우면 뒤늦게 열린 파일
      // 핸들이 .part를 되살린다 — 한도 초과 때 실제로 찌꺼기가 남았다.
      await closed(sink);
      fs.rmSync(temp, { force: true });
      throw error;
    }

    if (bytes === 0) {
      fs.rmSync(temp, { force: true });
      throw new AttachmentError('빈 첨부는 받지 않습니다', 400);
    }

    // 여기서부터 끝까지 await가 없다 — 레코드 읽고-고쳐-쓰기가 통째로 이어져야 한다.
    return commit(eventId, kind, meta, temp, bytes, uploadedAt);
  }

  function attachLocalFile(
    eventId: string,
    meta: ReceiveMeta & { sourceAttachmentId?: string },
    absolutePath: string,
  ): Attachment {
    requireRecord(eventId);
    const kind = validateKind(meta.kind);
    const stat = fs.statSync(absolutePath);
    const folder = store.eventDir(eventId);
    fs.mkdirSync(folder, { recursive: true });

    const uploadedAt = now();
    // 이미 이벤트 폴더 안에 있으면 옮기지 않고 그 자리를 그대로 가리킨다.
    const inside = path.relative(folder, absolutePath);
    if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
      return append(eventId, {
        attachmentId: nextId(eventId, uploadedAt),
        eventId,
        kind,
        path: inside,
        bytes: stat.size,
        originalName: meta.originalName ?? path.basename(absolutePath),
        capturedAt: validCapturedAt(meta.capturedAt, uploadedAt),
        uploadedAt,
        ...(meta.sourceAttachmentId ? { sourceAttachmentId: meta.sourceAttachmentId } : {}),
      });
    }
    return commit(eventId, kind, meta, absolutePath, stat.size, uploadedAt, meta.sourceAttachmentId);
  }

  /** 임시(또는 외부) 파일을 최종 이름으로 옮기고 레코드에 붙인다. */
  function commit(
    eventId: string,
    kind: AttachmentKind,
    meta: ReceiveMeta,
    sourceFile: string,
    bytes: number,
    uploadedAt: number,
    sourceAttachmentId?: string,
  ): Attachment {
    const folder = store.eventDir(eventId);
    const attachmentId = nextId(eventId, uploadedAt);
    const fileName = `${attachmentId}.${extensionFor(kind, meta)}`;
    fs.renameSync(sourceFile, path.join(folder, fileName));

    return append(eventId, {
      attachmentId,
      eventId,
      kind,
      path: fileName,
      bytes,
      ...(meta.originalName ? { originalName: meta.originalName } : {}),
      capturedAt: validCapturedAt(meta.capturedAt, uploadedAt),
      uploadedAt,
      ...(sourceAttachmentId ? { sourceAttachmentId } : {}),
      // 영상은 붙는 순간부터 재구성 대기다. 사진·산출물은 재구성 대상이 아니다.
      ...(kind === 'video'
        ? {
          recon: {
            status: 'pending' as ReconStatus,
            pipeline: RECON_PIPELINE,
            ...(meta.scaleRef ? { scaleRef: meta.scaleRef } : {}),
          },
        }
        : {}),
    });
  }

  function append(eventId: string, attachment: Attachment): Attachment {
    const record = requireRecord(eventId);
    const attachments = attachmentsOf(record);
    attachments.push(attachment);
    record.attachments = attachments;
    store.save(record);
    return attachment;
  }

  function nextId(eventId: string, uploadedAt: number): string {
    const record = store.read(eventId);
    const seq = attachmentsOf(record).length + 1;
    return `att-${uploadedAt}-${seq}`;
  }

  function patchRecon(
    eventId: string,
    attachmentId: string,
    patch: Partial<ReconState>,
  ): Attachment | null {
    const record = requireRecord(eventId);
    const attachments = attachmentsOf(record);
    const target = attachments.find((a) => a.attachmentId === attachmentId);
    if (!target) return null;

    target.recon = {
      status: target.recon?.status ?? 'pending',
      pipeline: target.recon?.pipeline ?? RECON_PIPELINE,
      ...target.recon,
      ...patch,
    };
    record.attachments = attachments;
    store.save(record);
    return target;
  }

  return {
    receive,
    attachLocalFile,
    patchRecon,
    get: (eventId, attachmentId) =>
      attachmentsOf(store.read(eventId)).find((a) => a.attachmentId === attachmentId) ?? null,
    list: (eventId) => attachmentsOf(store.read(eventId)),
    absolutePathOf: (attachment) =>
      path.join(store.eventDir(attachment.eventId), attachment.path),
  };
}

/** 지금 쓰는 도구 조합. 바꾸면 기존 레코드와 구분되도록 이 값도 같이 바꾼다. */
export const RECON_PIPELINE = 'ffmpeg+colmap+opensplat';

export function attachmentsOf(record: { attachments?: unknown } | null): Attachment[] {
  return Array.isArray(record?.attachments) ? (record.attachments as Attachment[]) : [];
}

export function isAttachmentKind(value: unknown): value is AttachmentKind {
  return typeof value === 'string' && (ATTACHMENT_KINDS as readonly string[]).includes(value);
}

function validateKind(kind: unknown): AttachmentKind {
  if (!isAttachmentKind(kind)) {
    throw new AttachmentError(`kind는 ${ATTACHMENT_KINDS.join(' | ')} 중 하나여야 합니다`, 400);
  }
  return kind;
}

/**
 * 확장자는 올라온 이름에서 **고르기만** 한다. 허용 목록에 없으면 종류별 기본값으로 떨어뜨린다.
 * 이름을 그대로 쓰면 `../../x.sh` 같은 값이 파일 경로가 된다.
 */
function extensionFor(kind: AttachmentKind, meta: ReceiveMeta): string {
  const allowed = EXTENSIONS[kind];
  const fromName = String(meta.originalName ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (allowed.includes(fromName)) return fromName;

  const fromType = String(meta.contentType ?? '').split(';')[0].split('/').pop()?.toLowerCase() ?? '';
  if (allowed.includes(fromType)) return fromType;
  if (fromType === 'quicktime' && kind === 'video') return 'mov';

  return DEFAULT_EXTENSION[kind];
}

/** 쓰기 스트림이 닫힐 때까지 기다린다. 이미 닫혀 있으면 바로 돌아온다. */
function closed(sink: fs.WriteStream): Promise<void> {
  if (sink.closed) return Promise.resolve();
  return new Promise((resolve) => {
    sink.once('close', () => resolve());
    sink.destroy();
  });
}

function validCapturedAt(value: unknown, fallback: number): number {
  return Number.isFinite(value as number) && (value as number) > 0 ? (value as number) : fallback;
}
