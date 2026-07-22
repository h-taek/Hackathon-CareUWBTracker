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

측위 소스는 `--source sim|live`로 고른다(기본 `sim`). `sim`은 시뮬레이터가 자동으로 태그를 움직이며 스트림을 방출하고, `live`는 실측 ingest(`POST /ingest`)만 `/stream`으로 내보낸다.

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
  config/anchor.ts     필수 앵커 실행 인자 파싱 · 검증 · 도움말
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
  public/index.html    2D 대시보드

tools/                 개발 전용 도구(서버 런타임과 무관) — 루트로 분리
  cli.ts generator.ts replay.ts sender.ts csv.ts evaluate.ts report.ts
  samples/  results/  README.md

test/                  모든 테스트 — 루트로 분리, 소스 구조 미러
  detection/ ingest/ positioning/ lib/ config/ tools/  fixtures/
```

런타임 경로: `server.ts` → `ingest/`(수신) + `positioning/`(측위) + `detection/`(낙상) + `sim.ts`(데모) + `lib/`(포맷). `tools/`·`test/`는 서버가 로드하지 않는다. 상대 import는 NodeNext 규칙상 `.ts` 확장자를 명시한다.
