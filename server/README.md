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

낙상 주입은 `GET /inject-fall?tagId=<ID>&scenario=confirm|cancel`이다. `confirm`은 후보 다음 5초 뒤 확진을, `cancel`은 3초 뒤 해제를 이어서 낸다(기본 `confirm`). 감지기를 거치지 않는 화면 검증용 트리거라 측위 소스와 무관하게 동작한다.

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
  sim.ts               데모용 시뮬레이터(가짜 보행/낙상 주입)
  map.json             좌표계 범위·구역 메타
  lib/
    ingest-log.ts      수신 프레임 → 콘솔 한 줄 포맷(순수 함수)
    zone.ts            (x,y) → 구역 라벨(순수 함수)
  ingest/              런타임 ingest 수신부
    endpoint.ts        POST /ingest 핸들러(검증 → onIngest → 202)
    validate.ts        spec 03 §5 스키마 검증(accel-only 허용, 최대 2앵커)
    body.ts            HTTP 본문 파싱 + 타입별 에러(400/413/415)
  positioning/         측위
    handler.ts         ingest → 위치 핸들러 팩토리
    from-ingest.ts     main/sub 거리 추출 → 삼각측량 → 위치 레코드
    triangulate.ts     2앵커 기하(순수 함수)
    smoother.ts        태그별 최근 5개 좌표 이동평균(방출 전 적용)
  detection/           낙상 감지
    fall.ts            고전 상태머신(B4)
    cascade.ts         고전 + LightGBM 2단계 캐스케이드(기본)
    features.ts        충격 윈도우 코어 19특징
    lgbm.ts            LightGBM 앙상블 추론(무의존)
    model-lgbm.json    학습된 모델(dump_lgbm.py 산출)
  static/              정적 파일 서빙
    resolve.ts         요청 경로 → public/ 파일 해석 + MIME(순수 함수)
    handler.ts         스트리밍 응답 · 304 재검증 · HEAD
  public/              브라우저가 받는 것 전부 (디스크 배치 = URL)
    index.html         대시보드 마크업
    assets/css/        base.css(공통 토큰·리셋) · dashboard.css(대시보드 레이아웃)
    assets/js/         dashboard.js(캔버스 렌더 · SSE 구독 · 경보 상태머신)
                       scene3d.js(3D 실사 패널 — 스플랫 뷰어 · 마커 · 좌표 정합, ESM)
    assets/splat/      스플랫 씬(git 제외 — README의 curl로 조달) + scene.json(씬·정합 설정, git 포함)
    vendor/            three.js · gaussian-splats-3d 정적 동봉(빌드 없음, README 참조)

tools/                 개발 전용 도구(서버 런타임과 무관) — 루트로 분리
  cli.ts generator.ts replay.ts sender.ts csv.ts evaluate.ts report.ts
  samples/  results/  README.md

test/                  모든 테스트 — 루트로 분리, 소스 구조 미러
  detection/ ingest/ positioning/ lib/ config/ tools/  fixtures/
```

런타임 경로: `server.ts` → `ingest/`(수신) + `positioning/`(측위) + `detection/`(낙상) + `sim.ts`(데모) + `lib/`(포맷). `tools/`·`test/`는 서버가 로드하지 않는다. 상대 import는 NodeNext 규칙상 `.ts` 확장자를 명시한다.

## 페이지·에셋 추가

API 라우트(`/ingest` `/stream` `/map` `/inject-fall` `/tags`)를 먼저 처리하고, 나머지는 전부 `public/` 정적 서빙으로 떨어진다. **디스크 배치가 곧 URL이므로 페이지를 늘려도 서버 코드는 손대지 않는다.**

| 파일 | URL |
|---|---|
| `public/index.html` | `/` , `/index.html` |
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
