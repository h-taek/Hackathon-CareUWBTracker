# Ingest 시뮬·리플레이 하네스

모바일 앱 없이 spec 03 §5의 원시 ingest를 생성하거나, 저장된 NDJSON을 기록 당시 간격대로 재생한다. B1 ingest 수신·B2 삼각측량·B4 낙상 판정 개발용이다. Node 내장 모듈만 사용하므로 별도 설치가 필요 없다.

## 생성

기본값은 가속도 50Hz, 앵커 간 거리 4m다. 출력은 한 줄에 JSON 하나인 NDJSON이다.

```bash
node demo/harness/cli.js generate
```

유한 개수만 생성해 빠르게 확인할 수 있다.

```bash
node demo/harness/cli.js generate --count 10
```

3초 후 `자유낙하 0.4초 -> 충격 0.2초 -> 정지 2.4초`를 주입한다.

```bash
node demo/harness/cli.js generate --fall-after 3
```

샘플링 주기와 앵커 간 거리를 바꿀 수 있다.

```bash
node demo/harness/cli.js generate --hz 25 --anchor-distance 5
```

B1 서버로 직접 전송할 수 있다.

```bash
node demo/harness/cli.js generate --url http://localhost:8080/ingest
```

## 리플레이

포함된 짧은 낙상 미리보기 샘플을 원래 50Hz 간격으로 재생한다.

```bash
node demo/harness/cli.js replay demo/harness/samples/fall-preview.ndjson
```

`--speed`로 배속 재생할 수 있다.

```bash
node demo/harness/cli.js replay demo/harness/samples/fall-preview.ndjson --speed 10
```

리플레이 데이터도 B1 서버로 직접 전송할 수 있다.

```bash
node demo/harness/cli.js replay demo/harness/samples/fall-preview.ndjson --url http://localhost:8080/ingest
```

NDJSON은 빈 줄과 `#` 주석을 허용한다. 각 데이터에는 0 이상의 숫자 `ts`가 필요하며, 타임스탬프는 이전 줄보다 과거일 수 없다.

## B1 연결 지점

CLI는 기본적으로 ingest JSON을 표준 출력으로 내보내며, `--url`을 주면 같은 레코드를 HTTP POST로 전송한다. HTTP writer는 빠르게 들어온 레코드도 순서를 유지해 전송한다. 생성기와 리플레이 코어는 전송 방식과 분리돼 있다.

## 평가 (evaluate) — 고전 감지기 베이스라인 성적

정규화 CSV(`ml/normalize_falls.py` 출력)의 라벨된 trial을 고전 낙상 감지기(`demo/detection/fall.js`)에 통째로 흘려 혼동행렬을 뽑는다. 이 감지기의 성적이 곧 AI가 넘어야 할 기준선(spec 04 §6)이고, AI 감지기도 같은 하네스로 비교한다.

```bash
node demo/harness/cli.js evaluate ml/datasets/_normalized/waist_falls_50hz.csv
```

두 판정 수준을 함께 낸다.

- candidate: 충격(impactG) 감지 순간. 순수 신호 분별력이며 `impactG` 하나에만 의존한다.
- confirmed: 충격 + 무동작 5초 확인. 라이브 게이트 효과이며 짧은 클립이나 즉시 회복하는 trial은 미확진일 수 있다(정상).

CSV는 g 단위, 감지기는 m/s²를 기대하므로 하네스가 gravity를 곱해 넣는다. trial마다 새 감지기 인스턴스를 써서 상태가 새지 않는다. 대용량 CSV는 한 줄씩 스트리밍하며 trial 단위로 끊어 평가한다(메모리 안전).

### 임계 스윕(트레이드오프 곡선)

`--sweep`은 감지기의 전 임계값을 각각 단독으로 흔들어(1D 스윕, 나머지는 기본값) 민감도-특이도-헛경보 곡선을 낸다. 스윕 대상 위치는 기본 waist(다회 패스용으로 해당 위치 trial만 메모리에 타입배열로 압축 캐시), `all`이면 전체.

```bash
node demo/harness/cli.js evaluate ml/datasets/_normalized/waist_falls_50hz.csv --sweep --json demo/harness/results/waist_eval.json
```

파라미터별 affects 표기: `candidate+confirmed`(impactG) / `confirmed`(settleMs·immobilityMs·immobilityBandG·movementG) / `flag-only`(freefallG·freefallWindowMs — 감지를 게이트하지 않고 이벤트의 freefall 표시 플래그만 바꿈, 곡선 불변). `--json`으로 기계가독 결과도 저장한다.

`demo/harness/results/`에 최근 실행 결과(허리·마스터)를 저장해 둔다.

## 테스트

```bash
node --test demo/harness/*.test.js
```
