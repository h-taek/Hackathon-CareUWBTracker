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
| `OPENSPLAT_BIN` `COLMAP_BIN` `FFMPEG_BIN` `FFPROBE_BIN` | 이름 그대로 | 실행 파일 경로 |
| `RECON_AUTO` | `1` | `0`이면 업로드해도 자동으로 안 건다(도구 없는 자리) |
| `RECON_FRAMES` | **300** | 목표 프레임 수. 영상 길이에 맞춰 **고르게** 뽑는다 |
| `RECON_FRAME_WIDTH` | **0** | 프레임 가로 픽셀. **0이면 원본 그대로** |
| `RECON_ITERS` | **30000** | 3DGS 학습 반복 수 |
| `RECON_GPU` | `1` | COLMAP 특징 추출·매칭에 GPU 사용. `0`이면 CPU |
| `ATTACHMENT_LIMIT_MB` | 2048 | 업로드 한도. **아이폰 4K 30fps가 분당 약 310MB**다 |

**화면 폼의 기본값도 같다**(테스트로 묶어 뒀다).

### 기본값은 전부 상류 것이다

우리가 고른 값이 하나도 없다.

| 값 | 출처 |
|---|---|
| 목표 300장 | Nerfstudio `ns-process-data video`의 `num_frames_target` |
| 가로 0(원본) | Nerfstudio는 COLMAP에 원본을 넘긴다. COLMAP 4.x의 `FeatureExtraction.max_image_size`도 `-1`(무제한) |
| 학습 30000회 | OpenSplat `--num-iters` |
| COLMAP GPU 켬 | COLMAP `FeatureExtraction.use_gpu` / `FeatureMatching.use_gpu` |
| 순차 매칭 | Nerfstudio가 영상일 때 쓰는 `matching_method` |

**이 장비에서는 1건에 10~15분쯤 걸린다.** COLMAP 매핑이 CPU 전용이고 프레임 장수에 급히 늘어나기 때문이다(1600px 128장에 80초 실측). 그래도 기본값을 깎지 않는 이유는 **근거 없는 중간값이 기준 행세를 하면 안 되기 때문**이다. 급하면 화면에서 낮추고, 그 값은 "이번에 이렇게 돌렸다"로 기록에 남는다.

상류와 다르게 둔 것은 카메라 모델 둘뿐이다 — `ImageReader.single_camera=1`(폰 한 대로 찍었다), `ImageReader.camera_model=OPENCV`(기본 `SIMPLE_RADIAL`보다 왜곡을 잘 잡는다).

### 프레임은 고르게 뽑는다

`fps`가 아니라 **목표 장수**로 잡는다. ffprobe로 길이를 재서 `장수 ÷ 길이`를 추출 간격으로 쓴다.

| 영상 길이 | 추출 간격 | 결과 |
|---|---|---|
| 64초 | 4.688fps | 300장 |
| 119초 | 2.521fps | 300장 |
| 5분 | 1fps | 300장 |

fps로 잡던 때는 **119초 영상의 앞 75초만 쓰고 뒤를 통째로 버렸다.** 길이를 못 재면 3fps로 폴백하고 그 사실을 로그와 화면에 남긴다.

### 자세를 못 풀 때 만지는 순서

기본값으로 돌려 `등록 N/M장`이 낮으면 이 순서로 본다. 판정 지표는 `recon.log`의 `Features: NN (SIFT)` — **수백 대면 위험, 수천은 돼야 한다.**

1. **목표 프레임 ↑** (300 → 500) — 이웃 프레임 겹침을 늘린다
2. **GPU 끄기** — 특징점을 17% 더 확보한다
3. 그래도 안 되면 **재촬영**. 설정으로 못 메우는 촬영이 있다(아래 지침)

**빨리 확인만 하려면 목표 프레임을 줄인다**(300 → 120). 시간을 먹는 것은 학습이 아니라 자세 계산이고, 그건 프레임 장수에 급히 늘어난다. 학습은 GPU라 30000회여도 몇 분이다. 자세가 풀리는 걸 확인한 뒤 프레임을 올려 다시 건다.

## 어디에 CPU를 쓰고 어디에 GPU를 쓰나

| 단계 | 장치 | 비고 |
|---|---|---|
| ffmpeg 프레임 추출 | CPU | 몇 초라 문제 안 된다 |
| COLMAP 특징 추출 | **GPU** (`RECON_GPU=0`이면 CPU) | OpenGL(SiftGPU) 경로 |
| COLMAP 매칭 | **GPU** (같은 스위치) | |
| **COLMAP 매핑(자세 계산)** | **CPU** | **여기가 병목이다.** 옵션은 있으나 CUDA 전용이라 이 장비에서 못 쓴다 |
| OpenSplat 학습 | **GPU (Metal/MPS)** | `-DGPU_RUNTIME=MPS` 빌드 |

**COLMAP의 GPU는 CUDA가 아니라 OpenGL이다.** brew의 `without CUDA` 빌드에서도 돈다. 실측(1600×1200 40장, M5 Max):

| | CPU | GPU |
|---|---|---|
| 특징 추출 | 13.2초 | **3.1초** |
| 매칭 | 12.4초 | **9.2초** |
| 찾은 특징점 평균 | **13,157** | 10,952 (−17%) |

GPU가 빠른 대신 **특징점을 덜 찾는다**. 자세를 못 푸는 장면에서는 꺼보는 게 방법이다(화면의 `COLMAP에 GPU 사용` 체크 해제).

**화면 세션이 없는 환경(SSH 등)에서는 GPU 경로가 OpenGL 컨텍스트를 못 잡아 실패할 수 있다.** 그때는 `RECON_GPU=0`으로 띄운다.

**매핑 단계는 이 장비에서 GPU로 못 내린다.** `--Mapper.ba_use_gpu` 옵션은 있는데 켜면 COLMAP이 직접 답한다.

```
W bundle_adjustment_ceres.cc:186] Requested to use GPU for bundle adjustment,
  but COLMAP was compiled without CUDA support. Falling back to CPU-based solvers.
```

Ceres의 GPU 가속이 cuSOLVER/cuDSS 기반이라 Metal 구현이 없고, 애플 실리콘에는 CUDA가 아예 없다. **CUDA 장비가 생기면 그때 켜진다.** 매핑의 나머지 절반인 증분 등록 루프는 앞 결과가 나와야 다음이 정해지는 순차·분기 구조라 원리적으로 GPU 대상이 아니다.

**학습(OpenSplat)은 Metal로 확실히 돈다.** 같은 입력 300회 학습에서 MPS 3.0초 vs `--cpu` 243초, **81배**다. 산출물 크기는 둘 다 같다.

그래서 시간을 줄이려면 **학습 반복이 아니라 프레임 장수**를 줄인다.

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

## 진행 표시

화면(`/recon`)은 **단계 번호와 그 단계 안의 진행**을 보여준다. `4/6 프레임 매칭 · 94/300장 · 31%` 같은 식이다. 도구가 찍는 줄을 그대로 읽는다.

| 단계 | 읽는 줄 |
|---|---|
| 프레임 추출 | `frame=37` (ffmpeg `-progress pipe:1`) |
| 특징 추출 | `Processed file [37/128]` |
| 프레임 매칭 | `Processing image [94/128]` |
| 자세 계산 | `Registering image #67 (num_reg_frames=42)` |
| 3DGS 학습 | `Step 660: 0.076039 (66%)` |

**전체 %는 안 만든다.** 단계별 소요가 입력에 따라 뒤집히기 때문이다 — 학습을 30000회로 올리면 학습이, 프레임을 500장으로 올리면 자세 계산이 지배한다. 없는 가중치를 지어내면 "60%에서 5분째 안 움직인다"가 된다.

**자세 계산만 총량을 모른다.** `num_reg_frames`는 지금까지 등록한 수이고 최종 몇 장이 등록될지는 끝나봐야 안다. 그래서 이 단계는 채워지는 막대 대신 **흐르는 막대**로 보이고 숫자만 실제 값을 쓴다. 실패한 촬영이 `등록 2장`에서 안 움직이는 것도 정확한 표시다.

진행 중인 재구성은 주소에 남는다(`/recon?watch=<eventId>/<attachmentId>`). **15분짜리 작업 중에 새로고침해도 화면이 다시 붙는다.**

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
