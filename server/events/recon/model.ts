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

/**
 * 이 모델로 3DGS를 돌릴 값어치가 있는지. `frameCount`는 ffmpeg가 뽑은 장수다.
 * 사유 문구에 원인 후보를 같이 담는다 — 로그를 열어보기 전에 다음 촬영을 고칠 수 있게.
 */
export function judgeModel(stats: ModelStats, frameCount: number): ModelVerdict {
  const { registeredImages, points } = stats;
  const ratio = frameCount > 0 ? registeredImages / frameCount : 0;
  const shot = `${frameCount}장 중 ${registeredImages}장 등록(${Math.round(ratio * 100)}%), 점 ${points}개`;
  const hint = '벽·천장처럼 무늬 없는 면이 많거나, 빨리 움직여 흔들렸거나, 프레임 간격이 넓어 겹침이 모자란 경우다.'
    + ' RECON_FPS를 올리고 RECON_FRAME_WIDTH를 키운 뒤 다시 걸어본다.';

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
