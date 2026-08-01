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

기본값은 `PATH`의 `opensplat`·`colmap`·`ffmpeg`다. 빌드한 자리를 직접 가리키려면:

```bash
OPENSPLAT_BIN="$PWD/tools/recon/OpenSplat/build/opensplat" node server/server.ts …
```

| 변수 | 기본 | 뜻 |
| --- | --- | --- |
| `OPENSPLAT_BIN` `COLMAP_BIN` `FFMPEG_BIN` | 이름 그대로 | 실행 파일 경로 |
| `RECON_AUTO` | `1` | `0`이면 업로드해도 자동으로 안 건다(도구 없는 자리) |
| `RECON_FPS` | 2 | 초당 뽑을 프레임 수 |
| `RECON_MAX_FRAMES` | 150 | 프레임 장수 상한. COLMAP 매칭 시간이 장수를 따라 급히 는다 |
| `RECON_FRAME_WIDTH` | 1600 | 프레임 가로 픽셀. **COLMAP 특징 추출이 CPU라** 4K 원본은 몇 시간이 된다 |
| `RECON_ITERS` | 2000 | 3DGS 학습 반복 수 |
| `ATTACHMENT_LIMIT_MB` | 2048 | 업로드 한도. **아이폰 4K 30fps가 분당 약 310MB**다 |

## 촬영 지침

- **치수를 실측한 물건을 화면에 반드시 넣는다.** 없으면 결과의 절대 크기를 못 믿는다. 업로드할 때 `scaleLabel`·`scaleMm`로 같이 올린다
- 한 바퀴 돌면서 천천히. 겹침이 모자라면 COLMAP이 자세를 못 푼다
- **바닥 물기와 얇은 매트는 범위 밖이다.** 반사면에서 재구성이 실패한다(`docs/research/06_3dgs-incident-documentation.md`)

## 실패했을 때

`server/data/events/<eventId>/recon/<attachmentId>/recon.log`에 실행한 명령줄과 도구 출력이 그대로 남는다. `recon.status`가 `failed`면 첫 줄 요약이 레코드의 `recon.error`에 있다.

| 증상 | 대개 이것 |
|---|---|
| `frames: 프레임이 N장뿐이다` | 영상이 너무 짧거나 `RECON_FPS`가 낮다 |
| `colmap:map` 실패 | 겹침 부족 또는 카메라 이동이 없다(제자리 회전만으로는 못 푼다) |
| `opensplat` 종료코드 ≠ 0 | sparse 점이 안 나왔거나 메모리 부족. `RECON_MAX_FRAMES`를 줄인다 |
