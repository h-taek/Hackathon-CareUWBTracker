# assets/splat/ — 가우시안 스플랫 씬

여기 둔 `.splat`/`.ply`/`.ksplat`은 **git 제외**(용량 수십~수백 MB, `.gitignore` 참조).
iCloud 동기화는 유지되므로 같은 맥에서는 다시 받을 필요가 없다. 새로 클론했다면 아래로 조달한다.

## 성능 스파이크용 공개 샘플 (plan/07 게이트)

3D팀 실사 스캔(8/02 수령) 전에 "이 브라우저가 이 정도 스플랫을 몇 fps로 그리나"를 재기 위한
공개 에셋이다. 원본은 INRIA 3DGS 논문의 학습 결과를 `.splat`(32바이트/스플랫)로 변환한 것.

```bash
cd server/public/assets/splat
for f in room train garden; do
  curl -L -o "$f.splat" "https://huggingface.co/cakewalk/splat-data/resolve/main/$f.splat"
done
```

| 파일 | 크기 | 스플랫 수 | 성격 |
|---|---|---|---|
| `room.splat` | 51 MB | 약 159만 | **실내 방** — 우리 데모 씬에 가장 가까움. 기준 케이스 |
| `train.splat` | 33 MB | 약 103만 | 소형 야외. 하한 케이스 |
| `garden.splat` | 187 MB | 약 583만 | 대형 야외. **상한 스트레스** — 여기서 버티면 실사 맵도 안전 |

(스플랫 수 = 파일 크기 / 32바이트)

`cakewalk/splat-data`는 antimatter15/splat 데모가 쓰는 공개 미러다. 스파이크 측정 전용이며
데모 화면에는 3D팀 실사 스캔이 들어간다 — **최종 산출물에 이 에셋을 싣지 않는다.**

## 측정 방법

서버를 띄우고 `/spike/gs` 에서 씬을 골라 `측정 시작`. 자세한 절차는 `../../spike/README.md`.
