// COLMAP sparse 모델이 쓸 만한지 판정한다(R-3).
//
// **왜 필요한가.** COLMAP은 자세를 거의 못 풀어도 종료코드 0으로 끝난다. 그러면 OpenSplat이
// 카메라 2대짜리 모델을 받아 학습을 "성공"으로 마치고, 아무 쓸모 없는 .ply가 나온다.
// 실제로 178장 중 2장만 등록된 결과가 `status: done`으로 기록됐다 — 그걸 막는 게 이 모듈이다.
//
// 판정은 COLMAP이 쓴 이진 파일의 머리 8바이트만 읽어서 한다(등록 이미지 수 / 점 수).
// `colmap model_analyzer`를 부르고 출력을 파싱하는 것보다 값싸고, 형식이 안 바뀐다.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ModelStats {
  /** 자세를 푼 이미지 수. 뽑은 프레임 수가 아니다. */
  registeredImages: number;
  /** sparse 점 수. OpenSplat의 초기화 입력이다. */
  points: number;
}

export interface ModelVerdict extends ModelStats {
  ok: boolean;
  /** 못 쓴다고 볼 때 사람이 읽는 사유. ok면 빈 문자열 */
  reason: string;
}

/** 이만큼도 못 풀었으면 무엇을 하든 장면이 안 선다. */
export const MIN_REGISTERED_IMAGES = 8;
/** 뽑은 프레임 대비 이 비율은 등록돼야 한다. 절반 넘게 버려졌다면 촬영이나 설정이 잘못된 것이다. */
export const MIN_REGISTERED_RATIO = 0.3;
/** 점이 이보다 적으면 3DGS 초기화가 사실상 빈 상태에서 시작한다. */
export const MIN_POINTS = 300;

/** COLMAP 이진 파일은 머리 8바이트가 항목 수(uint64 LE)다. 없거나 깨졌으면 0. */
function countIn(file: string): number {
  try {
    const handle = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(8);
      if (fs.readSync(handle, head, 0, 8, 0) < 8) return 0;
      return Number(head.readBigUInt64LE(0));
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return 0;
  }
}

export function readModelStats(modelDir: string): ModelStats {
  return {
    registeredImages: countIn(path.join(modelDir, 'images.bin')),
    points: countIn(path.join(modelDir, 'points3D.bin')),
  };
}

export interface ModelChoice extends ModelStats {
  /** 고른 서브모델 폴더 이름(`sparse/` 아래). 쓸 만한 게 하나도 없으면 null */
  name: string | null;
  /** 본 후보 전부. 뭘 버렸는지 로그에 남기려고 들고 있는다 */
  candidates: Array<{ name: string } & ModelStats>;
}

/** OpenSplat이 읽는 자리. `<project>/sparse/0/cameras.bin`만 본다(OpenSplat colmap.cpp:15). */
export const PRIMARY_MODEL_DIR = '0';

/**
 * COLMAP이 만든 서브모델 중 제일 큰 것을 고른다.
 *
 * **왜 필요한가.** 자세가 한 덩어리로 안 풀리면 COLMAP은 서브모델을 여러 개 만들고
 * `sparse/0`, `sparse/1`… 로 **완성 순서대로** 번호를 매긴다. 크기순이 아니다.
 *
 * 실측(2026-08-02, att-6): `0`에 2장짜리 찌꺼기가, `1`에 진짜 결과 259장(관측 30만,
 * 재투영 오차 0.60px)이 들어 있었다. `0`만 읽던 탓에 **성공한 재구성이 6번 연속
 * "자세를 못 풀었다"로 기록**됐다. 촬영을 아무리 바꿔도 결과가 같았던 이유다.
 */
export function pickBestModel(sparseRoot: string): ModelChoice {
  let names: string[];
  try {
    names = fs.readdirSync(sparseRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // sparse 폴더 자체가 없는 경우다. 여기서 던지면 판정 문구 없이 죽는다.
    names = [];
  }

  const candidates = names
    .map((name) => ({ name, ...readModelStats(path.join(sparseRoot, name)) }))
    .filter((entry) => entry.registeredImages > 0)
    // 등록 장수가 먼저다. 같으면 점이 많은 쪽 — 3DGS 초기화가 그만큼 촘촘해진다.
    .sort((a, b) => b.registeredImages - a.registeredImages || b.points - a.points);

  const best = candidates[0];
  if (!best) return { name: null, registeredImages: 0, points: 0, candidates };
  return {
    name: best.name,
    registeredImages: best.registeredImages,
    points: best.points,
    candidates,
  };
}

/**
 * 고른 모델을 `sparse/0`으로 올린다. OpenSplat이 거기만 읽기 때문이다.
 *
 * 원래 `0`에 있던 것은 지우지 않고 고른 모델 자리로 맞바꿔 남긴다 — 실패를 파고들 때
 * COLMAP 로그와 대조할 수 있어야 한다.
 */
export function promoteModel(sparseRoot: string, name: string): void {
  if (name === PRIMARY_MODEL_DIR) return;

  const primary = path.join(sparseRoot, PRIMARY_MODEL_DIR);
  const chosen = path.join(sparseRoot, name);
  if (!fs.existsSync(primary)) {
    fs.renameSync(chosen, primary);
    return;
  }

  const parked = path.join(sparseRoot, `swap-${name}`);
  fs.rmSync(parked, { recursive: true, force: true });
  fs.renameSync(primary, parked);
  fs.renameSync(chosen, primary);
  fs.renameSync(parked, chosen);
}

/**
 * 이 모델로 3DGS를 돌릴 값어치가 있는지. `frameCount`는 ffmpeg가 뽑은 장수다.
 * 사유 문구에 원인 후보를 같이 담는다 — 로그를 열어보기 전에 다음 촬영을 고칠 수 있게.
 */
export function judgeModel(stats: ModelStats, frameCount: number): ModelVerdict {
  const { registeredImages, points } = stats;
  const ratio = frameCount > 0 ? registeredImages / frameCount : 0;
  const shot = `${frameCount}장 중 ${registeredImages}장 등록(${Math.round(ratio * 100)}%), 점 ${points}개`;
  // 장수를 늘리라는 안내는 하지 않는다. 실측(2026-08-02)에서 300장→1500장은
  // 102분을 더 쓰고 결과가 같았다. 자세가 안 풀리는 원인은 장수가 아니라 동선이다.
  const hint = '제자리에서 돌지 말고 벽을 따라 걸으며 찍어야 한다 — 카메라가 움직여야 거리가 계산된다.'
    + ' 무늬 없는 흰 벽·천장이 화면을 채우는 구간과 흔들린 구간을 줄이고, 40~60초를 겹치게 담는다.';

  if (registeredImages < MIN_REGISTERED_IMAGES) {
    return { ...stats, ok: false, reason: `COLMAP이 카메라 자세를 거의 못 풀었다 — ${shot}. ${hint}` };
  }
  if (ratio < MIN_REGISTERED_RATIO) {
    return { ...stats, ok: false, reason: `등록된 프레임이 너무 적다 — ${shot}. ${hint}` };
  }
  if (points < MIN_POINTS) {
    return { ...stats, ok: false, reason: `sparse 점이 너무 적어 3DGS 초기화가 안 된다 — ${shot}. ${hint}` };
  }
  return { ...stats, ok: true, reason: '' };
}
