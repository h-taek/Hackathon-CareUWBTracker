# tools/recon — 사고 현장 3DGS 재구성 도구

서버가 자식 프로세스로 부르는 외부 도구들이다. 파이프라인 코드는 `server/events/recon/`에 있고, 여기는 **도구 조달과 빌드 절차**만 쥔다.

```
영상 → ffmpeg(프레임) → COLMAP(카메라 자세 + sparse 점) → OpenSplat(3DGS 학습) → .ply
```

OpenSplat은 sparse 점이 없으면 못 돈다(랜덤 초기화 미지원). 그래서 COLMAP이 선택이 아니라 **필수 단계**다.

## 왜 OpenSplat인가 (2026-08-01)

| 후보 | 라이선스 | macOS | 판정 |
|---|---|---|---|
| Inria 원본 3DGS | 연구·평가 전용 | CUDA 전용 | 상용 불가 |
| gsplat (Nerfstudio) | Apache-2.0 | **CUDA 전용, CPU 경로 없음** | 장비가 없어 지금 못 돈다 |
| **OpenSplat** | **AGPLv3** | **Metal/MPS 정식 지원** | **채택 — 이 장비에서 도는 유일한 선택지** |

개발 장비가 Apple Silicon(M5 Max)이라 CUDA가 없다. **해커톤에서 구현을 확인하는 것이 먼저**라 AGPL을 안고 OpenSplat으로 간다.

**라이선스가 서버 코드까지 번지지 않는다.** 라이브러리로 링크하지 않고 `opensplat` 실행 파일을 자식 프로세스로 부르기 때문이다(`server/events/recon/runner.ts`). 별도 바이너리 호출은 일반적으로 파생저작물로 보지 않는다. 남는 쟁점은 OpenSplat 자체를 재배포하거나 그것을 네트워크 서비스로 제공할 때인데, 지금은 **각자 자기 장비에 설치하는 구조**다. 제품 경로에서 SW 구독(트랙 3)으로 팔 때 이 판단을 다시 한다 — 그때는 CUDA 장비 + gsplat이 후보다.

## 설치 (macOS, Apple Silicon)

```bash
brew install colmap cmake pytorch opencv@4
```

**COLMAP은 4.x여야 한다.** 4.x에서 GPU 스위치가 `--SiftExtraction.use_gpu` → `--FeatureExtraction.use_gpu`, `--SiftMatching.use_gpu` → `--FeatureMatching.use_gpu`로 옮겨갔다. 3.x로 돌리면 `unrecognised option`으로 `colmap:extract` 단계에서 멎는다(`recon.log`에 그대로 남는다).

`opencv@4`를 쓴다. **OpenCV 5는 `calib3d` 모듈이 재편돼 OpenSplat 링크가 깨진다** (`ld: library 'opencv_calib3d' not found`). 5가 이미 깔려 있어도 상관없다 — 아래 `OpenCV_DIR`이 4를 가리킨다.

Metal 툴체인은 Xcode에 기본으로 안 들어 있다. 없으면 `error: cannot execute tool 'metal'`로 빌드가 멎는다.

```bash
xcodebuild -downloadComponent MetalToolchain
xcode-select -p   # /Applications/Xcode.app/Contents/Developer 여야 한다
```

## 빌드

```bash
git clone https://github.com/pierotofy/OpenSplat.git tools/recon/OpenSplat
cd tools/recon/OpenSplat && mkdir -p build && cd build

cmake -DCMAKE_PREFIX_PATH="/opt/homebrew/opt/pytorch;/opt/homebrew/opt/opencv@4" \
      -DOpenCV_DIR=/opt/homebrew/opt/opencv@4/lib/cmake/opencv4 \
      -DGPU_RUNTIME=MPS ..
make -j$(sysctl -n hw.logicalcpu)
./opensplat            # 사용법이 나오면 성공
```

`tools/recon/OpenSplat/`은 git에서 제외돼 있다(소스 + 빌드가 수 GB).

**빌드 로그를 파이프로 넘길 때 종료코드를 확인하라.** `make ... | tail`은 `tail`의 종료코드를 돌려주므로 실패가 성공으로 보인다.

## 서버에 물리기

**서버가 알아서 찾는다.** `tools/recon/OpenSplat/build/opensplat`이 있으면 그것을 쓰고, 없으면 `PATH`의 `opensplat`으로 떨어진다. `colmap`·`ffmpeg`는 brew로 깔려 `PATH`에 있다. 그래서 평소에는 앵커 인자만 주면 된다.

```bash
node server/server.ts \
  --main-anchor-id phoneMain --sub-anchor-id phoneSub \
  --anchor-distance 4 --half-plane positive
```

시작 배너가 실제로 고른 경로를 찍고, 못 찾으면 그 자리에서 경고한다 — **재구성을 걸고 나서 알면 COLMAP을 몇 분 돌린 뒤다.** 다른 자리에 빌드했으면 `OPENSPLAT_BIN`으로 지정한다.

**재구성 설정(fps·장수·가로·학습 횟수)은 화면에서 실행마다 넣는다**(`/recon`). 아래 환경변수는 서버 기본값 자리로만 남는다.

| 변수 | 기본 | 뜻 |
| --- | --- | --- |
| `OPENSPLAT_BIN` `COLMAP_BIN` `FFMPEG_BIN` | 이름 그대로 | 실행 파일 경로 |
| `RECON_AUTO` | `1` | `0`이면 업로드해도 자동으로 안 건다(도구 없는 자리) |
| `RECON_FPS` | **3** | 초당 뽑을 프레임 수 |
| `RECON_MAX_FRAMES` | **180** | 프레임 장수 상한. **매핑이 CPU 전용이라 여기가 시간을 정한다** |
| `RECON_FRAME_WIDTH` | **2000** | 프레임 가로 픽셀. 특징점 수가 여기에 가장 민감하다 |
| `RECON_ITERS` | **15000** | 3DGS 학습 반복 수 |
| `RECON_GPU` | `1` | COLMAP 특징 추출·매칭에 GPU 사용. `0`이면 CPU |
| `ATTACHMENT_LIMIT_MB` | 2048 | 업로드 한도. **아이폰 4K 30fps가 분당 약 310MB**다 |

**화면 폼의 기본값도 같다.** 두 벌이 다르면 "기본으로 돌렸다"가 어느 쪽인지 알 수 없어진다(테스트로 묶어 뒀다).

### 권장값을 이렇게 잡은 근거

M5 Max 실측(1600px 128장): COLMAP 추출 GPU 10초 · 매칭 29초 · **매핑 80초(CPU 전용)** · 학습 1500회 12초. **매핑이 병목이고 프레임 장수에 급히 늘어난다.**

| 값 | 왜 |
|---|---|
| `fps 3` | 1~2분 촬영이면 200~360장. 이웃 프레임 겹침을 벌기 위한 값 |
| `최대 180장` | 매핑 시간을 2분 안쪽으로 묶는 선 |
| `가로 2000px` | 특징점 수가 여기에 가장 민감하다. 4K 원본을 그대로 넣으면 몇 시간 |
| `학습 15000회` | 상류 기본은 30000. **1500회는 눈에 띄게 뿌옇다(실측).** 15000은 그 사이에서 고른 값이고 품질은 아직 안 쟀다 |

전체 **6분 안팎**을 예상한다.

### 자세를 못 풀 때 만지는 순서

기본값으로 돌려 `등록 N/M장`이 낮으면 이 순서로 올린다. 판정 지표는 `recon.log`의 `Features: NN (SIFT)` — **수백 대면 위험, 수천은 돼야 한다.**

1. **가로 2000 → 2800** — 특징점이 가장 크게 는다
2. **fps 3 → 5** (최대 장수도 같이 올린다) — 이웃 겹침을 늘린다
3. **GPU 끄기** — 특징점을 17% 더 확보한다
4. 그래도 안 되면 **재촬영**. 설정으로 못 메우는 촬영이 있다(아래 지침)

**빨리 확인만 하고 싶으면 학습 횟수를 1000으로 내린다.** 자세가 풀리는지만 보는 거라 뿌옇게 나와도 상관없고, 5분이 3분이 된다. 풀린 걸 확인한 뒤 `다시 변환`으로 15000회를 건다.

## 어디에 CPU를 쓰고 어디에 GPU를 쓰나

| 단계 | 장치 | 비고 |
|---|---|---|
| ffmpeg 프레임 추출 | CPU | 몇 초라 문제 안 된다 |
| COLMAP 특징 추출 | **GPU** (`RECON_GPU=0`이면 CPU) | OpenGL(SiftGPU) 경로 |
| COLMAP 매칭 | **GPU** (같은 스위치) | |
| **COLMAP 매핑(자세 계산)** | **CPU 전용** | **여기가 병목이다.** GPU 경로가 아예 없다 |
| OpenSplat 학습 | **GPU (Metal/MPS)** | `-DGPU_RUNTIME=MPS` 빌드 |

**COLMAP의 GPU는 CUDA가 아니라 OpenGL이다.** brew의 `without CUDA` 빌드에서도 돈다. 실측(1600×1200 40장, M5 Max):

| | CPU | GPU |
|---|---|---|
| 특징 추출 | 13.2초 | **3.1초** |
| 매칭 | 12.4초 | **9.2초** |
| 찾은 특징점 평균 | **13,157** | 10,952 (−17%) |

GPU가 빠른 대신 **특징점을 덜 찾는다**. 자세를 못 푸는 장면에서는 꺼보는 게 방법이다(화면의 `COLMAP에 GPU 사용` 체크 해제).

**화면 세션이 없는 환경(SSH 등)에서는 GPU 경로가 OpenGL 컨텍스트를 못 잡아 실패할 수 있다.** 그때는 `RECON_GPU=0`으로 띄운다.

**매핑 단계는 GPU로 못 내린다.** COLMAP의 증분 매핑은 번들 조정(Ceres)이라 CPU 전용이고, 지금 파이프라인에서 가장 오래 걸리는 곳이다. 줄이려면 프레임 장수를 줄이는 수밖에 없다.

## 촬영 지침

- **치수를 실측한 물건을 화면에 반드시 넣는다.** 없으면 결과의 절대 크기를 못 믿는다. 업로드할 때 `scaleLabel`·`scaleMm`로 같이 올린다
- 한 바퀴 돌면서 **천천히**. 겹침이 모자라면 COLMAP이 자세를 못 푼다. 이웃 프레임이 60% 이상 겹치는 속도로 움직인다
- **무늬 없는 면을 오래 비추지 않는다.** 흰 벽·천장·유리는 특징점이 안 나온다. 항상 가구나 물건이 화면에 걸치게 둔다
- 한 물건을 중심으로 원을 그리며 도는 것이 좋다. 제자리에서 카메라만 휙휙 돌리면 시차가 없어 못 푼다

**URL에 한글을 그대로 넣지 않는다.** `name=현장영상.MOV` 같은 값은 Node의 HTTP 파서가 요청 줄에서 거부해 **본문 없는 400**으로 끝난다(우리 코드는 실행조차 안 된다). `name`은 생략하거나 퍼센트 인코딩한다.
- **바닥 물기와 얇은 매트는 범위 밖이다.** 반사면에서 재구성이 실패한다(`docs/research/06_3dgs-incident-documentation.md`)

## 산출 .ply를 보는 법

**일반 3D 뷰어로 열면 안 된다.** Xcode Quick Look·Preview·메시랩 같은 도구는 이 파일을 평범한 점군으로 읽는데, 3DGS `.ply`는 점마다 불투명도·크기·회전·구면조화(SH) 색을 따로 담는 다른 물건이다. 헤더를 보면 바로 안다.

```
element vertex 15010
property float x / y / z
property float f_dc_0 / f_dc_1 / f_dc_2      ← 색이 RGB가 아니라 SH 계수다
property float f_rest_0 … f_rest_44          ← 방향별 색
property float opacity, scale_0..2, rot_0..3 ← 일반 뷰어가 통째로 무시한다
```

일반 뷰어는 `x/y/z`만 집어 **색도 크기도 없는 희끄무레한 점 덩어리**를 보여준다. 렌더가 이상한 게 아니라 읽는 방식이 다른 것이다.

**동봉 뷰어로 본다.** 재구성 산출물은 이 뷰어에 얹으려고 만든 것이고, 성능 게이트도 이걸로 통과했다.

```bash
cp server/data/events/<eventId>/recon/<attachmentId>/scene.ply \
   server/public/assets/splat/check.ply
# server/public/assets/splat/scene.json 의 "url"을 "/assets/splat/check.ply"로 바꾼다
```

브라우저에서 대시보드를 열면 뜬다. 씬 교체 절차 전문은 `../../server/public/assets/splat/README.md`.

바깥 도구로 보고 싶으면 3DGS를 아는 것을 쓴다 — [SuperSplat 웹 에디터](https://superspl.at/editor)(브라우저에서 파일을 열기만 하면 된다), PlayCanvas, Postshot.

## 결과가 이상할 때 — 먼저 등록 장수를 본다

`.ply`가 나왔다고 잘 된 게 아니다. **COLMAP이 몇 장을 풀었는지**가 품질을 정한다.

```bash
colmap model_analyzer --path server/data/events/<eventId>/recon/<attachmentId>/project/sparse/0
```

`Images:`가 뽑은 프레임 수에 한참 못 미치면 그 결과는 못 쓴다. 파이프라인이 이 값을 자동으로 보고 모자라면 `failed`로 끊지만(등록 8장 미만, 30% 미만, 점 300개 미만), 통과한 뒤에도 낮으면 흐릿하게 나온다. 등록 장수와 점 수는 `recon.log`에도 남는다.

**COLMAP이 못 푸는 촬영 세 가지.**

| 원인 | 화면에서 보이는 것 | 대응 |
|---|---|---|
| 무늬 없는 면 | 흰 벽·천장·유리가 화면을 채움 | 가구·물건이 걸치게 찍는다. 벽만 훑지 않는다 |
| 흔들림 | 프레임이 뭉개져 있음 | **천천히** 걷는다. 4K 30fps라도 빨리 돌리면 뭉갠다 |
| 겹침 부족 | 프레임마다 완전히 다른 곳 | `RECON_FPS`를 올린다. 이웃 프레임이 60% 이상 겹쳐야 한다 |

`recon.log`의 `Features: NN (SIFT)`가 프레임당 특징점 수다. **수백 대면 이미 위험하고 수천은 돼야 한다.**

## 실패했을 때

`server/data/events/<eventId>/recon/<attachmentId>/recon.log`에 실행한 명령줄과 도구 출력이 그대로 남는다. `recon.status`가 `failed`면 첫 줄 요약이 레코드의 `recon.error`에 있다.

| 증상 | 대개 이것 |
|---|---|
| `frames: 프레임이 N장뿐이다` | 영상이 너무 짧거나 `RECON_FPS`가 낮다 |
| `colmap:map` 실패 | 겹침 부족 또는 카메라 이동이 없다(제자리 회전만으로는 못 푼다) |
| `opensplat` 종료코드 ≠ 0 | sparse 점이 안 나왔거나 메모리 부족. `RECON_MAX_FRAMES`를 줄인다 |
