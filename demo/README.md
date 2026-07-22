# demo — 실내 측위 + 낙상 감지 데모 서버

Node 내장 HTTP와 TypeScript로 구현한 데모 서버다. 워치·폰이 보낸 ingest를 받아 2앵커 삼각측량 좌표와 가속도를 SSE로 흘리고 2D 대시보드에 그린다. 기존 JavaScript 도메인 모듈은 검증된 동작을 유지하며 TypeScript 서버에서 재사용한다.

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

기존 진입점도 같은 인자를 붙여 `node demo/server.js --main-anchor-id phoneMain --sub-anchor-id phoneSub --anchor-distance 4 --half-plane positive`로 실행할 수 있다. 전체 옵션은 `npm start -- --help`로 확인한다.

## 테스트

```bash
npm test
npm run typecheck
```

## 디스크 구조 (책임별)

```
demo/
  config/
    anchor.ts          필수 앵커 실행 인자 파싱 · 시작 전 검증 · 도움말
  server.ts            TypeScript HTTP 서버 · 라우팅 · SSE 허브 · sim 배선(조립부)
  server.js            기존 Node 실행 호환 진입점
  sim.js               데모용 시뮬레이터(가짜 보행/낙상 주입) — 기기 없이 대시보드 확인
  map.json             좌표계 범위·구역 메타
  lib/
    ingest-log.js      수신 프레임 → 콘솔 한 줄 포맷(순수 함수, 테스트됨)
  ingest/              런타임 ingest 수신부(서버가 로드)
    endpoint.js        POST /ingest 핸들러(검증 → onIngest → 202)
    validate.js        spec 03 §5 스키마 검증(accel-only 허용, 최대 2앵커)
    body.js            HTTP 본문 파싱 + 타입별 에러(400/413/415)
  positioning/         측위(서버가 로드)
    handler.js         ingest → 위치 핸들러 팩토리
    from-ingest.js     main/sub 거리 추출 → 삼각측량 → 위치 레코드
    triangulate.js     2앵커 기하(순수 함수)
    smoother.ts        태그별 최근 5개 좌표 이동평균(방출 전 적용)
  harness/             개발용 도구(서버 런타임과 무관, 기기 없이 ingest 생성/재생)
    cli.js             generate/replay CLI
    generator.js       합성 ingest 프레임 + 낙상 시나리오
    replay.js          NDJSON 타임드 재생
    sender.js          순서 보존 HTTP POST writer
    samples/           재생용 NDJSON 샘플
    README.md          하네스 사용법
  public/index.html    2D 대시보드
```

런타임 경로: `server.ts` → `ingest/`(수신) + `positioning/`(측위) + `sim.js`(데모) + `lib/`(포맷). `harness/`는 서버가 로드하지 않는 독립 개발 도구다.
