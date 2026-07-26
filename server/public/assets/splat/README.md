# assets/splat/ — 가우시안 스플랫 씬

대시보드 3D 실사 패널이 띄우는 씬이 여기 있다. 어떤 파일을 띄우고 맵 좌표를 씬 좌표에
어떻게 맞출지는 **`scene.json`**(이 폴더, git 포함)이 정한다 — 실사 맵을 받으면 그 파일의
`url`과 `align` 숫자만 갈아끼우면 된다.

`.splat`/`.ply`/`.ksplat` 자체는 **git 제외**(용량 수십~수백 MB, `.gitignore` 참조).
iCloud 동기화는 유지되므로 같은 맥에서는 다시 받을 필요가 없다. 새로 클론했다면 아래로 조달한다.

## 프록시 씬 조달

3D팀 실사 스캔(8/02 수령) 전까지 쓰는 공개 에셋이다. 원본은 INRIA 3DGS 논문의 학습 결과를
`.splat`(32바이트/스플랫)로 변환한 것.

```bash
cd server/public/assets/splat
for f in room train garden; do
  curl -L -o "$f.splat" "https://huggingface.co/cakewalk/splat-data/resolve/main/$f.splat"
done
```

| 파일 | 크기 | 스플랫 수 | 쓰임 |
|---|---|---|---|
| `room.splat` | 51 MB | 약 159만 | **실내 방 — `scene.json` 기본값.** 우리 데모 씬에 가장 가깝다 |
| `train.splat` | 33 MB | 약 103만 | 소형 야외. 가벼운 확인용 |
| `garden.splat` | 187 MB | 약 583만 | 대형 야외. 실사 맵이 무거울 때를 대비한 상한 스트레스 |

(스플랫 수 = 파일 크기 / 32바이트)

`cakewalk/splat-data`는 antimatter15/splat 데모가 쓰는 공개 미러다. **최종 데모 산출물에는
이 에셋을 싣지 않는다** — 3D팀 실사 스캔으로 교체한다.

`room.splat`이 없으면 3D 패널이 뜨지 않고 안내 문구만 나온다(2D 관제는 그대로 동작).

## 실사 맵을 받으면

1. 파일을 이 폴더에 두고 `scene.json`의 `url`을 바꾼다.
2. `align.mode`를 `"fixed"`로 바꾸고 실측값을 채운다 — `unitsPerMeter`(스플랫 1단위 = 몇 m),
   `origin`(맵 원점이 씬에서 어디), `yawDegrees`(맵 +x축 방향), `floorY`(바닥면 높이).
   `auto`는 맵 bounds를 씬 범위에 눌러 담는 임시 정합이라 실제 방 구조와 맞지 않는다.
3. **성능을 다시 잰다.** 게이트 측정(2026-07-26)은 `.splat` 기준이었는데 이 포맷은 구면조화(SH)
   데이터를 담지 않는다 — `.ply` 등 SH를 담는 포맷으로 받으면 렌더 비용이 달라진다.
   무거우면 `scene.json`의 `quality.sphericalHarmonicsDegree`부터 내린다(2 → 1 → 0).
