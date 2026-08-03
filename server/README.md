# server — 실내 측위 + 낙상 감지 서버

Node 내장 HTTP와 TypeScript로 구현한 서버다. 워치·폰이 보낸 ingest를 받아 2앵커 삼각측량 좌표와 가속도를 SSE로 흘리고 2D 대시보드에 그린다. 런타임 전체가 TypeScript ESM이며, 외부 의존성 없이 Node 22.18+의 네이티브 TS 실행으로 구동된다.

## 요구 사항

- Node.js 22.18 이상(내장 TypeScript 실행 사용)

## 실행

```bash
npm install
npm start -- \
  --main-anchor-id phoneMain \
  --sub-anchor-id phoneSub \
  --anchor-distance 4 \
  --half-plane positive
```

전체 옵션은 `npm start -- --help`로 확인한다.

측위 소스는 `--source sim|live`로 고른다(기본 `sim`). `sim`은 시뮬레이터가 자동으로 태그를 움직이며 스트림을 방출하고, `live`는 실측 ingest(`POST /ingest`)만 `/stream`으로 내보낸다. 실기기 검증은 `live`로 띄워야 시뮬 태그가 섞이지 않는다.

실행 인자는 `config/cli.ts`가 소유자별로 나눠 각 설정 모듈에 넘기고, 아무도 안 가져간 인자는 거기서 한 번만 거절한다. 서버 옵션을 추가할 때 손대는 자리도 `config/cli.ts` 한 곳이다.

### 서브폰 없이 화면만 볼 때 (`--single-anchor-bearing`)

서브폰(앵커2)이 없으면 거리가 하나뿐이라 삼각측량이 성립하지 않고 마커가 아예 안 그려진다. 화면 확인이 목적일 때만 방향을 고정해 좌표를 만든다(spec/system 03 §5.3).

```bash
npm start -- \
  --main-anchor-id phoneMain --sub-anchor-id phoneSub \
  --anchor-distance 4 --half-plane positive \
  --source sim --single-anchor-bearing 45
```

메인 앵커 거리 r을 45도 방향에 얹어 `(r·cos45°, r·sin45°)`에 놓는다. **거리는 실측이라 워치를 들고 폰에서 멀어지면 마커도 그만큼 멀어지지만, 방향은 설정값이다.** 서브 앵커 거리가 같이 들어오면 삼각측량이 이기므로 서브폰이 붙는 순간 정상 경로로 돌아간다.

`--source sim`과 같이 쓰면 배경 시뮬 태그 3명이 도는 화면 위에 실기기 태그 하나가 얹혀, 대시보드 전체를 채운 상태로 확인할 수 있다.

흔적은 세 군데 남는다: 시작 배너 경고, 태그별 첫 프레임 경고(`[position] ⚠ … 1앵커 추정 좌표입니다`), position 페이로드의 `estimate` 필드. **측위 정확도 근거로는 쓸 수 없으니 리허설·시연에서는 이 인자를 뺀다.**

낙상 주입은 `GET /inject-fall?tagId=<ID>&clip=<클립 ID>`다. 클립 목록은 `GET /clips`. **주입은 실제 파이프라인을 그대로 통과한다** — 공개 데이터셋에서 잘라둔 가속도 구간을 ingest 프레임으로 되돌려(`inject/`) `validateIngest` → 삼각측량 → 스무딩 → 낙상 감지 순으로 흘리고, 경보는 감지기가 낸다. 그래서 응답에는 경보가 없고 재생 정보(`clipId` `frames` `durationMs`)만 들어 있다. 결과는 `/stream`으로 나온다.

클립이 정하는 건 입력 신호뿐이고 결과는 감지기가 정한다. 헛경보 클립처럼 AI가 기각하는 신호는 아무 경보도 안 낸다(기각 사실은 `[fall] 기각 ...` 로그에만 남는다). 클립을 다시 만드는 법은 `tools/README.md`.

데이터셋에는 UWB 거리가 없으므로 태그가 서 있던 좌표에서 앵커 거리를 거꾸로 만들어 넣는다(`positioning/to-ranges.ts`). 좌표를 직접 꽂지 않는 이유는 그래야 삼각측량·스무딩까지 실측과 같은 코드를 타기 때문이다. 재생 중에는 그 태그를 시뮬 대상에서 빼(`sim.freeze`) 5Hz 시뮬 좌표와 50Hz 주입 좌표가 마커를 뺏지 않게 한다.

주입 프레임도 ingest라 `formatIngestLine` 로그가 프레임마다 찍힌다(50Hz × 10초 ≈ 500줄). 실측 ingest와 같은 취급이라 일부러 그대로 뒀다.

## 마커 떨림 억제

UWB 거리는 제자리에 서 있어도 수 cm씩 흔들린다. 이동평균만 걸면 그 흔들림이 마커의 제자리 떨림으로 남고, 창을 키우면 떨림 대신 지연이 커질 뿐이라 맞바꾸기가 된다. 그래서 **정지와 이동을 나눠서 다룬다**(`positioning/smoother.ts`).

프레임 하나가 거치는 순서:

1. **클램프 제외** — `geom.clamped`가 붙은 좌표는 측정값이 아니라 삼각측량 실패 신호다. 평균에 넣지 않고 직전 좌표를 유지한다. 넣으면 마커가 실제 위치와 `y=0` 사이를 왕복한다.
2. **이상치 컷** — 직전에 받아들인 좌표에서 `0.8m + 3m/s × 프레임간격`을 넘게 튄 프레임은 버린다. 5회 연속 버려지면 튄 게 아니라 실제 이동(재연결·달리기)으로 보고 창을 비운다. 기준점은 화면 좌표가 아니라 마지막으로 창에 넣은 원본이다 — 화면이 고정된 동안 천천히 걸어가는 것을 이상치로 자르지 않기 위해서다.
3. **이동평균** — 태그별 최근 5개.
4. **데드밴드** — 정지 중에는 평활 좌표가 0.4m 안에서 노는 동안 마커를 한 점에 고정한다. 반경을 벗어나면 이동으로 보고 **평활 좌표를 그대로 따라간다**(이동 중에도 반경을 걸면 걸음이 계단처럼 끊긴다). 0.3초 동안 0.15m도 못 움직이면 다시 고정으로 돌아간다.

좌표를 붙잡은 프레임에는 `hold: { reason: 'clamped' | 'outlier' | 'deadband' }`가 실린다 — **있으면 "이 프레임은 화면을 안 움직였다"는 뜻**이라 로그로 이유가 구분된다.

화면 쪽은 따로 하나 더 건다. 좌표는 10Hz로 들어오는데 그때마다 마커를 그 자리로 옮기면 초당 10번 순간이동해서 남은 오차가 진동으로 보인다. `dashboard.js`는 들어온 좌표를 목표로만 두고 화면 좌표를 60fps로 끌어당긴다(시상수 200ms). 노이즈가 줄어드는 게 아니라 튀는 대신 흐르게 보이는 것이다.

현장에서 재빌드 없이 조절하려면 환경변수를 쓴다.

| 변수 | 기본 | 뜻 |
| --- | --- | --- |
| `POS_WINDOW` | 5 | 이동평균 창(프레임) |
| `POS_DEADBAND_M` | 0.4 | 정지 고정 반경(m). 떨림이 남으면 올리고, 마커가 굼뜨면 내린다 |
| `POS_DEADBAND_MOVING_M` | 0.15 | 0.3초 동안 이만큼도 못 움직이면 정지로 판정 |
| `POS_MAX_JUMP_M` | 0.8 | 이상치 컷 기준 거리(m) |
| `POS_MAX_SPEED_MPS` | 3 | 이상치 컷에 더하는 속도 몫 |

떨림이 여전히 심하면 **앵커 배치부터 본다.** `y = √(rA² − x²)`라 두 앵커를 잇는 선 가까이(y가 작은 곳)에서는 거리 5cm 흔들림이 y로 수십 cm가 된다(민감도 ≈ rA/y). 동선을 기준선에서 떼는 게 어떤 필터보다 효과가 크다.

## 사고 기록 (R-1)

경보를 SSE로 뿌리고 끝내지 않는다. `fall_detected` 하나마다 **그 전후 구간의 궤적·가속도를 묶어 파일 하나**로 남긴다. 스키마는 `../docs/spec/system/03_data-interface.md` §6.1이고, 여기 남은 `eventId`가 R-2~R-4의 현장 영상·재구성 산출물이 붙을 자리다.

**화면으로 하는 게 빠르다.** `http://localhost:8080/recon` — 영상 올리기, 붙일 낙상 기록 고르기, 변환 설정, 진행 보기, 결과 3D 보기가 한 페이지에 있다. 관제 화면 상단의 `사고 현장 3D 기록` 버튼으로 넘어간다.

```bash
curl localhost:8080/events                  # 최신순 목록(요약). ?limit= ?tagId=
curl localhost:8080/events/<eventId>        # 전문 — 궤적·가속도·첨부까지
```

**이벤트 하나가 폴더 하나다.** 첨부가 붙으면 사고 1건이 파일 여러 개가 되므로 반출·삭제가 폴더 단위로 끝나게 뒀다. git에서 제외돼 있다.

```
server/data/events/<eventId>/
  record.json                    경보 + 전후 궤적·가속도
  <attachmentId>.mov             업로드된 현장 영상
  recon/<attachmentId>/          프레임 · COLMAP 프로젝트 · recon.log · scene.ply
```

레코드는 임시 파일에 쓰고 이름을 바꾸는 방식이라 쓰는 중에 목록을 읽어도 반쪽짜리 JSON이 안 나온다.

**기록은 경보 즉시 닫히지 않는다.** 사고 이후 구간이 필요하므로 `post` 창이 찰 때까지 기다린다. 프레임이 계속 오면 데이터로 닫고, 클립 재생이 끝나 ingest가 멎으면 벽시계 타이머가 있는 만큼으로 닫는다 — **둘 중 먼저 오는 쪽**이다.

| 변수 | 기본 | 뜻 |
| --- | --- | --- |
| `EVENTS_DIR` | `server/data/events` | 기록 저장 폴더 |
| `EVENT_PRE_MS` | 10000 | 경보 시각 이전으로 담을 구간(ms). 접근 동선이 보이는 길이 |
| `EVENT_POST_MS` | 10000 | 경보 시각 이후로 담을 구간(ms). 넘어진 뒤 정지가 보이는 길이 |
| `ATTACHMENT_LIMIT_MB` | 2048 | 업로드 한도. 아이폰 4K 30fps가 분당 약 310MB다 |

첨부·재구성 경로는 아래와 같다. **재구성 설정은 요청마다 받는다**(`fps` `maxFrames` `frameWidth` `iters`) — 환경변수는 서버 기본값 자리로만 남고, 화면이 실행마다 그 위를 덮는다. 도구 조달과 촬영 지침은 `../tools/recon/README.md`.

| 경로 | 뜻 |
| --- | --- |
| `POST /events/<id>/attachments?kind=video&…` | 본문이 파일 바이트 그대로다(multipart 아님). 201 + 첨부 정보 |
| `GET /events/<id>/attachments/<attId>` | 첨부 원본(영상·`.ply`) |
| `POST /events/<id>/attachments/<attId>/recon?…` | 재구성을 다시 건다. 설정을 같이 넘긴다 |
| `GET /events/<id>/attachments/<attId>/log?tail=N` | `recon.log` 꼬리 N줄 |

삼각측량이 보류된 프레임(accel-only)은 **가속도만 남고 궤적에는 안 들어간다.** 없는 위치를 지어내지 않기 때문이며, 그 구간은 화면에서도 비어 보이는 게 맞다.

## 테스트

```bash
npm test
npm run typecheck
```

## 디스크 구조 (책임별)

런타임(`server/`)·개발도구(`tools/`)·테스트(`test/`)를 루트에서 분리했다. 전부 TypeScript ESM이다.

```
server/                재사용 런타임
  server.ts            HTTP 서버 · 라우팅 · SSE 허브 · 소스 선택(조립부)
  config/cli.ts        실행 인자 전체의 소유자 · argv 분배 · 사용법 · 미지 인자 거절
  config/argv.ts       argv를 소유자별로 나누는 도구(takeFlags)
  config/anchor.ts     앵커 인자 파싱·검증(자기 플래그만 받는다)
  sim.ts               배경 태그 보행 시뮬레이터(경보는 안 만든다)
  map.json             좌표계 범위·구역 메타
  lib/
    ingest-log.ts      수신 프레임 → 콘솔 한 줄 포맷(순수 함수)
    zone.ts            (x,y) → 구역 라벨(순수 함수)
  ingest/              런타임 ingest 수신부
    endpoint.ts        POST /ingest 핸들러(검증 → onIngest → 202)
    validate.ts        spec/system 03 §5 스키마 검증(accel-only 허용, 최대 2앵커)
    body.ts            HTTP 본문 파싱 + 타입별 에러(400/413/415)
  positioning/         측위
    handler.ts         ingest → 위치 핸들러 팩토리
    from-ingest.ts     main/sub 거리 추출 → 삼각측량 → 위치 레코드
    triangulate.ts     2앵커 기하(순수 함수)
    to-ranges.ts       그 역함수 — 좌표 → 앵커 거리(클립 주입이 쓴다)
    smoother.ts        떨림 억제 — 클램프·이상치 제외 → 이동평균 → 정지 시 좌표 고정
  inject/              데모 주입 — 데이터셋 클립을 실제 파이프라인에 흘린다
    injector.ts        클립 → ingest 프레임 재생(태그별 1개, 겹치면 나중 것만)
    clip.ts            클립 로드·검증·요약
    clips/*.json       커밋된 원신호 구간 + 출처 + 기대 판정(tools/cli.ts clip으로 재생성)
  events/              사고 기록(R-1) — 경보를 뿌리고 끝내지 않고 전후 구간과 함께 남긴다
    recorder.ts        태그별 링버퍼 + 경보 전후 창을 모아 레코드로 닫기(파일 안 만짐)
    store.ts           레코드 1건 = 파일 1개. 저장·조회·목록 + eventId 경로 검증
    routes.ts          GET /events · /events/<id> 응답 생성(순수 함수)
  detection/           낙상 감지
    fall.ts            고전 상태머신. 충격을 잡아 정점 뒤 1.5초에 fall_detected 1건 발행
    cascade.ts         고전 + LightGBM 2단계 캐스케이드(기본). 낙상 여부는 여기서만 정한다
    features.ts        충격 윈도우 코어 19특징
    lgbm.ts            LightGBM 앙상블 추론(무의존)
    model-lgbm.json    학습된 모델(dump_lgbm.py 산출)
  static/              정적 파일 서빙
    resolve.ts         요청 경로 → public/ 파일 해석 + MIME(순수 함수)
    handler.ts         스트리밍 응답 · 304 재검증 · HEAD
  public/              브라우저가 받는 것 전부 (디스크 배치 = URL)
    index.html         대시보드 마크업(실시간 관제)
    recon/index.html   사고 현장 3D 기록 페이지 — /recon. 관제 상단 버튼으로 넘어간다
    assets/css/        base.css(공통 토큰·리셋) · dashboard.css(대시보드 레이아웃)
    assets/js/         dashboard.js(캔버스 렌더 · SSE 구독 · 경보 상태머신)
                       scene3d.js(관제용 3D 패널 — 씬 설정 · 마커 · 좌표 정합, ESM)
                       recon.js(사고 기록 화면 — 업로드 · 설정 · 진행 폴링 · 기록 조회)
                       splat-view.js(URL 하나로 스플랫만 띄우는 얇은 뷰어)
    assets/splat/      스플랫 씬(git 제외 — README의 curl로 조달) + scene.json(씬·정합 설정, git 포함)
    vendor/            three.js · gaussian-splats-3d 정적 동봉(빌드 없음, README 참조)

tools/                 개발 전용 도구(서버 런타임과 무관) — 루트로 분리
  cli.ts generator.ts replay.ts sender.ts csv.ts evaluate.ts report.ts
  samples/  results/  README.md

test/                  모든 테스트 — 루트로 분리, 소스 구조 미러
  detection/ events/ ingest/ positioning/ lib/ config/ tools/  fixtures/

data/events/           사고 기록 산출물(런타임 생성 · git 제외). EVENTS_DIR로 옮길 수 있다
```

런타임 경로: `server.ts` → `ingest/`(수신) + `positioning/`(측위) + `detection/`(낙상) + `events/`(사고 기록) + `inject/`(데모 주입) + `sim.ts`(배경 태그) + `lib/`(포맷). `tools/`·`test/`는 서버가 로드하지 않는다. 상대 import는 NodeNext 규칙상 `.ts` 확장자를 명시한다.

## 페이지·에셋 추가

API 라우트(`/ingest` `/stream` `/map` `/clips` `/inject-fall` `/tags` `/events`)를 먼저 처리하고, 나머지는 전부 `public/` 정적 서빙으로 떨어진다. **디스크 배치가 곧 URL이므로 페이지를 늘려도 서버 코드는 손대지 않는다.**

| 파일 | URL |
|---|---|
| `public/index.html` | `/` , `/index.html` |
| `public/recon/index.html` | `/recon` , `/recon/` |
| `public/login.html` | `/login` , `/login.html` |
| `public/report/index.html` | `/report` , `/report/` |
| `public/assets/js/dashboard.js` | `/assets/js/dashboard.js` |
| `public/vendor/…` `public/assets/scene.ply` | 같은 경로 그대로 |

- 확장자가 없으면 `<경로>.html` → `<경로>/index.html` 순으로 찾는다.
- 새 페이지는 `assets/css/base.css`만 링크하면 공통 토큰·버튼·카드가 붙는다.
- 디렉터리 목록은 내주지 않고, `public/` 밖으로 나가는 경로는 거부한다.
- 응답은 스트리밍이고 `Last-Modified` 기반 304 재검증을 한다(대용량 스플랫 대비).
- 새 확장자를 쓰려면 `static/resolve.ts`의 MIME 표에만 한 줄 추가한다.
- 정적 응답에는 교차출처 격리 헤더(`COOP: same-origin` / `COEP: require-corp`)가 실린다.
  스플랫 뷰어가 `SharedArrayBuffer`로 정렬 워커에 데이터를 복사 없이 넘기기 위한 조건이다.
  **외부 CDN 리소스를 쓰려면 이 헤더부터 재검토해야 한다** — 우리는 전부 vendor 동봉이라 무해하다.
