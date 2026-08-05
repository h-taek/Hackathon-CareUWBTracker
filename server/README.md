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

**앵커 ID 둘은 `map.json`의 같은 층에 적혀 있어야 한다.** 층은 좌표가 아니라 앵커가 정하므로(spec/system 03 §5.1), 이 대조가 곧 "실측 프레임이 몇 층 것인가"다. 어느 층에도 없거나 두 층에 갈려 있으면 서버가 뜨지 않는다 — **틀린 층으로 도는 서버는 사고 기록에 틀린 층을 박고, 그건 나중에 되돌릴 수 없다.** 시작 배너에 층 목록과 실측 앵커가 가리키는 층을 찍는다.

앵커 쌍이 하나뿐이라 `live`에서 데이터가 도는 층은 그 하나다. 나머지 층은 화면에 `데이터 없음`으로 뜬다.

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

`--source sim`과 같이 쓰면 배경 시뮬 태그가 도는 화면 위에 실기기 태그 하나가 얹혀, 대시보드 전체를 채운 상태로 확인할 수 있다. 배경 태그는 **층에 나뉘어 8명**이다(F1 3 · F2 2 · F3 2 · F4 1). 각자 자기 층의 통행 구역 안에서만 걷는다 — 층을 넘어 걸으면 없는 기능(층간 이동)을 흉내내게 된다.

흔적은 세 군데 남는다: 시작 배너 경고, 태그별 첫 프레임 경고(`[position] ⚠ … 1앵커 추정 좌표입니다`), position 페이로드의 `estimate` 필드. **측위 정확도 근거로는 쓸 수 없으니 리허설·시연에서는 이 인자를 뺀다.**

## 관제사 식별

**기록을 바꾸는 동작은 관제사를 고른 뒤에만 된다.** 판정·경보 해제·태그 등록/반납·수동 파기가 그렇고, 세션이 없으면 401 `operator_required`다. **조회와 측위(`POST /ingest`)는 막지 않는다** — 식별은 조작의 조건이지 감지의 조건이 아니다.

**관문은 별도 페이지다.** `http://localhost:8080/operator`에서 명부의 관제사를 고르면 관제 화면이 열린다. 같은 화면에서 관제사를 추가하거나 지운다. 관제 화면과 태그 관리 화면은 **세션이 없으면 뜨자마자 이 주소로 돌아간다.** **비밀번호는 없다** — 이유와 대외 서술 기준은 `../docs/spec/operation/03_operator-identity.md` §8.

상단바의 `관제사 변경`은 세션을 닫고 관문으로 나간다(교대 종료를 겸한다). **만료는 다르다** — 관제 중에 3시간이 차면 화면을 걷어내지 않고 흐린 팝업으로 막은 뒤 `연장`·`관제사 변경` 중에 고르게 한다. 연장은 같은 사람으로 세션을 다시 열어 **화면을 떠나지 않으므로 SSE가 안 끊긴다.**

| 경로 | 뜻 |
| --- | --- |
| `GET /session` | 지금 관제사, 만료 시각, 고를 수 있는 명부 |
| `POST /session?operatorId=&renew=` | 관제사 선택. 쿠키 `op_sid`를 발급한다. `renew=1`은 만료 팝업의 연장 |
| `DELETE /session` | 교대 종료 |
| `POST /operators/add?name=` | 명부 추가. 서버가 `op-N`을 매긴다 |
| `POST /operators/remove?operatorId=` | 명부에서 삭제. 그 관제사의 세션도 함께 끊긴다 |

명부는 `server/data/operators.json` 하나다(`OPERATORS_DIR`로 옮긴다). **태그 명부와 달리 모드로 나누지 않는다** — 시뮬이든 실기기든 화면 앞에 앉은 사람은 같은 사람이다. 파일이 없으면 `관제사 1~3`으로 깔린다.

**세션은 3시간이고 메모리에만 있다.** 재기동하면 다시 고른다 — 서버가 내려가 있던 사이에 교대가 있었는지 알 방법이 없는데 세션만 살아남으면 어제 사람 이름으로 오늘의 판정이 찍힌다. 만료되면 화면이 스스로 선택창으로 돌아간다.

확인자료의 `actor`는 이름이 아니라 `op-N`이다. 이름 대조는 명부에서 한다.

## 태그 등록·반납

**태그 명부에 있는 태그만 수집한다.** 명부에 없거나 반납한 태그의 프레임은 `POST /ingest` 진입점에서 버려진다 — 측위도 궤적 기록도 서버 로그도 낙상 판정도 돌지 않는다(`server.ts:isCollecting`). 개인위치정보 수집의 일시 중지를 태그 반납으로 갈음하는 구조이고, 근거와 계약은 `../docs/spec/operation/02_data-retention.md` §4.7이다.

화면은 `http://localhost:8080/registry` 한 페이지다. 관제 화면 상단바의 `태그 관리` 버튼이 **새 탭으로** 연다 — 같은 탭에서 넘어가면 그동안 SSE가 닫혀 관제가 끊긴다.

| 경로 | 뜻 |
| --- | --- |
| `GET /tags` | 수집 중인 태그만. 관제 화면이 이름을 여기서 찾는다 |
| `GET /tags/all` | 반납분까지 이력 전체 + 미등록 태그 목록(`pending`) |
| `POST /tags/register?tagId=&label=` | 배정. 표시명은 1~40자 |
| `POST /tags/release?tagId=` | 반납. 이 순간부터 그 태그를 처리하지 않는다 |
| `POST /ni/token` | 앵커 폰끼리 NI 토큰을 놓는다. 본문 `{from, to, token}` |
| `GET /ni/token?to=` | 그 앞으로 온 토큰. 가져가도 안 지운다(15초 만료) |

명부는 `server/data/tags/`에 있고 **모드마다 파일이 다르다**(`TAGS_DIR`로 옮긴다).

```
registry.live.json   실기기 (--source live)
registry.sim.json    시뮬  (--source sim)
```

한 파일을 같이 쓰면 시뮬로 띄울 때 자동 등록된 배경 태그가 남아, 다음에 실기기로 띄워도 "수집 중" 세 명이 앉아 있다. 명부는 지금 누구의 위치를 수집하는지를 말하는 장부라 거짓말하면 안 된다. 기동 배너에 **어느 장부를 들었는지** 찍히니, 명부가 비어 보이면 거기부터 본다.

**재기동해도 반납 상태가 유지된다** — 재기동으로 풀린다면 중지 수단이 아니다. 시뮬 배경 태그 8개는 `--source sim`일 때만 자동 등록되고, **이미 반납한 태그는 되살리지 않는다.**

**실기기(`--source live`)는 명부가 빈 채로 시작한다.** 워치를 켜면 프레임은 버려지지만 관리 화면의 `감지된 미등록 태그`에 `tag-watch`가 뜬다. 거기서 `배정`을 눌러 이름을 붙이면 그 순간부터 수집이 시작된다. 미등록 목록은 메모리에만 있고 60초 무신호면 사라진다.

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

## 학습 데이터 반출

시설에 설치된 서비스가 판정 모델 학습용 표본을 공급자 서버로 보낸다. 계약은 `../docs/spec/system/03_data-interface.md` §7, 법적 근거는 `../docs/research/01_legal.md` §9. **받는 서버는 이 저장소에 없다** — 보내는 쪽까지가 범위다.

**뽑는 자리는 파기 직전이다.** 감지 이벤트는 24시간이면 지워지는데(보관·파기), 지우기 직전에 표본을 뽑는다. 그 시점에는 번복 창이 닫혀 라벨이 확정돼 있고, 오경보 이벤트는 이 삭제로 완전히 사라져 마지막 기회다.

나가는 것은 이것뿐이다. 태그 ID·절대 시각·좌표·구역은 없다.

```json
{"dt":[0,20,40],"ax":[…],"ay":[…],"az":[…],"label":1,"peakAccel":3.8,"freefall":true,"aiScore":0.91,"hz":50}
```

| 변수 | 기본 | 뜻 |
| --- | --- | --- |
| `EXPORT_URL` | 없음 | **없으면 전송하지 않고 큐만 쌓는다. 기본이 off다** |
| `EXPORT_TOKEN` | 없음 | 있으면 `Authorization: Bearer` 헤더를 붙인다 |
| `EXPORT_DIR` | `server/data/export` | 큐 위치 |
| `EXPORT_KEEP_DAYS` | 7 | 보낸 배치를 며칠 두고 지울지 |

```
server/data/export/
  pending/<YYYY-MM-DD>.jsonl   아직 못 보낸 표본. 한 줄 한 표본
  sent/<YYYY-MM-DD>.jsonl      보낸 것(디스크 회수용으로만 남긴다)
  state.json                   마지막 전송 · 연속 실패 · 누계
```

**파일 하나가 배치 하나다.** 보내면 이름만 바꾸므로 중간에 죽어도 두 번 보내거나 잃지 않는다. 실패하면 1분에서 시작해 두 배씩, 상한 6시간으로 다시 건다. 4xx도 버리지 않는다.

거는 자리는 셋이다 — **기동 시 1회**, 파기가 돈 직후, 그 사이 10분마다. 파기 루프에만 매달면 뽑을 것이 있을 때만 큐가 비워져, 수집 서버가 죽었다 살아나도 다음 파기까지 밀린 배치가 앉아 있다.

**반출이 실패해도 파기는 진행한다.** 둘을 묶으면 전송 장애가 법정 파기 의무를 막는다.

### 런타임 흐름

전송을 거는 자리가 셋이고, 뽑는 자리는 하나다.

```
서버 기동
  └ createExporterFromEnv(dataDir)          server.ts:292   큐 + 전송기 조립(아직 아무것도 안 한다)
  └ retention.start()                       server.ts:1228  기동 시 파기 1회 + 24시간 주기
       └ sweep() ── 만료된 감지 이벤트마다
            ├ store.read(eventId)           retention.ts:137
            ├ exporter.collect(record)      retention.ts:168  ← 뽑는 자리는 여기 하나뿐
            │    ├ toSample(record)         sample.ts         판정 없으면 여기서 끝(건수만 센다)
            │    └ queue.append()           sender.ts:87      pending/<날짜>.jsonl에 한 줄
            └ store.remove(eventId)         retention.ts:177  뽑은 다음에 지운다
       └ exporter.flushSoon()               retention.ts:144  뽑은 게 있을 때만
  └ exporter.start()                        server.ts:1231  기동 1회 + 10분 주기
       └ flush()                            sender.ts:96
            ├ URL 없음 / 이미 도는 중 / 백오프 중이면 즉시 반환
            ├ queue.batches()               sender.ts:103   pending의 배치 파일 목록(오래된 것부터)
            ├ postBatch(file)               sender.ts:139   fetch POST · 헤더에 토큰
            ├ 2xx → queue.markSent(file)    sender.ts:113   pending → sent로 이름만 바꾼다
            ├ 실패 → nextAttemptAt 갱신     sender.ts:126   1분→2분→4분… 상한 6시간
            └ queue.sweepSent()             sender.ts:133   보관 지난 sent 정리
SIGINT/SIGTERM
  └ exporter.stop()                         server.ts:1239  주기 타이머 해제
```

`collect`는 동기이고 `flush`는 비동기다. **파기가 전송을 기다리지 않는다** — `flushSoon`은 결과를 안 기다린다. 기동 직후에는 파기가 건 flush가 아직 도는 중이라 `exporter.start()`의 flush가 `running` 가드에 막히고 그냥 반환한다. 같은 배치를 두 번 보내지 않는 자리다.

### 직접 확인하는 법

반출은 사고 발생 24시간 뒤에 일어나므로, 하루를 기다리지 않으려면 **이미 만료된 이벤트**를 심어야 한다. 터미널 셋이면 된다.

```bash
# 1) 만료된 이벤트 4건을 격리된 자리에 심는다 (낙상 2 · 오경보 1 · 미판정 1)
npm run export-demo

# 2) 수신 목업을 띄운다 (9100 포트)
npm run export-sink

# 3) 심은 자리를 DATA_DIR로 주고 서버를 띄운다 — 기동 시 파기가 돌면서 반출된다
DATA_DIR="server/data/export-demo" EXPORT_URL=http://localhost:9100/samples \
  npm start -- --main-anchor-id phoneMain --sub-anchor-id phoneSub \
               --anchor-distance 3 --half-plane positive
```

서버 쪽에 이렇게 뜬다.

```
[retention] 4건 처리 · 0.0MB 회수
[export] 3건 전송
```

목업 쪽에는 이렇게 뜬다. **미판정 1건은 안 온다** — 라벨이 없어 표본이 될 수 없다.

```
[sink] 3건 수신 · 낙상 2 · 오경보 1 → tools/sink-out/2026-08-05.jsonl
```

받은 파일을 열어보면 나간 것의 전부가 보인다. `demo-fall-2`는 모델이 0.44를 줬는데 사람이 낙상이라고 판정한 건이다 — 그런 표본이 학습 재료로 값이 제일 크다.

```bash
cat tools/sink-out/*.jsonl | head -1
cat server/data/export-demo/export/state.json    # 누계 · 미판정으로 버린 건수
```

**전송이 막히는 자리를 보려면** `EXPORT_TOKEN`을 목업이 요구하는 값과 다르게 준다.

```bash
SINK_TOKEN=facility-secret npm run export-sink                       # 2번 터미널
DATA_DIR="server/data/export-demo" EXPORT_URL=http://localhost:9100/samples \
  EXPORT_TOKEN=wrong npm start -- …                                  # 3번 터미널
```

`[export] 전송 실패(1회) — HTTP 401 · 다음 시도 1분 뒤`가 뜨고 배치는 `export/pending/`에 남는다. **이벤트는 그래도 파기된다.** 토큰을 고쳐 다시 띄우면 기동 1회 시도에서 밀린 배치가 나간다.

`server/data/export-demo`는 진짜 사고 기록(`server/data/events`)과 떨어진 자리다. 지우려면 폴더째 지우면 되고, 다시 심으려면 `npm run export-demo`를 다시 돌린다.

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
  sim.ts               배경 태그 보행 시뮬레이터(경보는 안 만든다). 태그마다 소속 층이 있다
  map.json             좌표계 범위 · 층 배열(층별 도면 경로 · 앵커 · 구역)
  map/
    floors.ts          맵 검증과 앵커→층 매핑. 어긋난 선언이면 서버를 안 띄운다
  lib/
    ingest-log.ts      수신 프레임 → 콘솔 한 줄 포맷(순수 함수). 사생활 구역은 좌표·거리를 가린다
    zone.ts            (x,y) → 구역 라벨·구역 객체(순수 함수)
    privacy.ts         사생활 구역 필터 — 좌표·오차·앵커 거리 폐기(순수 함수, F-6)
  tags/
    registry.ts        태그 명부. 등록·반납이 수집을 켜고 끈다(위치정보법 제24조②). 모드별 파일
    sightings.ts       명부에 없는 태그가 문을 두드린 기록(메모리 전용 · 60초 만료)
  operators/
    registry.ts        관제사 명부. 확인자료의 actor가 여기서 온다. 지워도 파일에는 남는다
    session.ts         관제 세션(메모리 전용 · 3시간) + 쿠키 읽기·쓰기
  ni/
    mailbox.ts         앵커 폰끼리 NI 토큰을 건네는 우편함(메모리 전용 · 15초 만료).
                       폰↔폰이 서로를 Bonjour로 찾던 자리를 대신한다 — spec/system 03 §5.4
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
    outcome.ts         관제사 판정과 전이 규칙(파일 안 만짐)
    retention.ts       보관기간 파기. 감지 이벤트를 지우기 직전에 학습 표본을 뽑는다
    export/            학습 데이터 반출 — 시설 밖으로 나가는 유일한 경로
      sample.ts        익명화. 레코드 → 가속도 창 + 라벨(순수 함수). 화이트리스트로 뽑는다
      queue.ts         파일 큐. 배치 하나 = 파일 하나. 보내면 이름만 바꾼다
      sender.ts        전송 + 백오프 재시도. 인증은 헤더로, 반출물은 본문으로
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
    index.html         관제 화면 마크업(실시간 관제 + 사고 현장 3D 탭)
    recon/index.html   사고 현장 3D 기록 — /recon. 영상 등록과 변환 진행만 맡는다
    registry/index.html 태그 등록·반납 페이지 — /registry
    operator/index.html 관제사 관문 — /operator. 여기를 지나야 위 화면들이 열린다
    _ds/               Industry 디자인 시스템 — 모든 화면이 이 토큰을 쓴다
    assets/css/        console.css(관제 레이아웃 · 상태색 --st-*) · recon.css · registry.css
                       operator.css(관문 페이지·상단바 칩·만료 팝업)
    assets/js/         console.js(관제 — 도면·마커·SSE 구독·경보·3D 탭)
                       recon.js(3D 기록 화면 — 업로드 · 설정 · 진행 폴링)
                       splat-view.js(URL 하나로 스플랫만 띄우는 얇은 뷰어)
                       registry.js(태그 명부 화면 — 등록·반납 요청과 목록 그리기)
                       operator.js(관문 가드 — 세션 확인·상단바·만료 팝업. 보호된 화면들이 같이 쓴다)
                       operator-page.js(관문 페이지 — 명부 선택·추가·삭제)
    assets/floorplan/  층별 2D 도면 SVG. 층 하나에 파일 하나다
    assets/splat/      스플랫 씬(git 제외 — README의 curl로 조달) + scene.json(씬·정합 설정, git 포함)
    vendor/            three.js · gaussian-splats-3d 정적 동봉(빌드 없음, README 참조)

tools/                 개발 전용 도구(서버 런타임과 무관) — 루트로 분리
  cli.ts generator.ts replay.ts sender.ts csv.ts evaluate.ts report.ts
  export-sink.ts       학습 반출 수신 목업(제품 아님 · 왕복 확인용)
  export-demo.ts       만료된 이벤트 심기(반출을 하루 안 기다리고 보는 용)
  samples/  results/  README.md

test/                  모든 테스트 — 루트로 분리, 소스 구조 미러
  detection/ events/ ingest/ positioning/ lib/ tags/ operators/ ni/ config/ tools/  fixtures/

data/events/           사고 기록 산출물(런타임 생성 · git 제외). EVENTS_DIR로 옮길 수 있다
data/tags/             태그 명부(런타임 생성 · git 제외). 모드별 파일. TAGS_DIR로 옮길 수 있다
data/operators.json    관제사 명부(런타임 생성 · git 제외). OPERATORS_DIR로 옮길 수 있다
data/export/           학습 반출 큐(런타임 생성 · git 제외). EXPORT_DIR로 옮길 수 있다
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
- 새 페이지는 `/_ds/styles.css`를 먼저 링크하고 그 위에 자기 CSS를 올린다. 색·서체·간격은
  전부 그 토큰에서 가져온다(`public/_ds/readme.md`).
- 디렉터리 목록은 내주지 않고, `public/` 밖으로 나가는 경로는 거부한다.
- 응답은 스트리밍이고 `Last-Modified` 기반 304 재검증을 한다(대용량 스플랫 대비).
- 새 확장자를 쓰려면 `static/resolve.ts`의 MIME 표에만 한 줄 추가한다.
- 정적 응답에는 교차출처 격리 헤더(`COOP: same-origin` / `COEP: require-corp`)가 실린다.
  스플랫 뷰어가 `SharedArrayBuffer`로 정렬 워커에 데이터를 복사 없이 넘기기 위한 조건이다.
  **외부 CDN 리소스를 쓰려면 이 헤더부터 재검토해야 한다** — 우리는 전부 vendor 동봉이라 무해하다.
