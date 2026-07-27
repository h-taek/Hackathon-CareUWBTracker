# Ingest 시뮬·리플레이 도구

모바일 앱 없이 spec 03 §5의 원시 ingest를 생성하거나, 저장된 NDJSON을 기록 당시 간격대로 재생한다. B1 ingest 수신·B2 삼각측량·B4 낙상 판정 개발용이다. Node 내장 모듈만 사용하므로 별도 설치가 필요 없다.

## 생성

기본값은 가속도 50Hz, 앵커 간 거리 4m다. 출력은 한 줄에 JSON 하나인 NDJSON이다.

```bash
node tools/cli.ts generate
```

유한 개수만 생성해 빠르게 확인할 수 있다.

```bash
node tools/cli.ts generate --count 10
```

3초 후 `자유낙하 0.4초 -> 충격 0.2초 -> 정지 2.4초`를 주입한다.

```bash
node tools/cli.ts generate --fall-after 3
```

샘플링 주기와 앵커 간 거리를 바꿀 수 있다.

```bash
node tools/cli.ts generate --hz 25 --anchor-distance 5
```

B1 서버로 직접 전송할 수 있다.

```bash
node tools/cli.ts generate --url http://localhost:8080/ingest
```

## 리플레이

포함된 짧은 낙상 미리보기 샘플을 원래 50Hz 간격으로 재생한다.

```bash
node tools/cli.ts replay tools/samples/fall-preview.ndjson
```

`--speed`로 배속 재생할 수 있다.

```bash
node tools/cli.ts replay tools/samples/fall-preview.ndjson --speed 10
```

리플레이 데이터도 B1 서버로 직접 전송할 수 있다.

```bash
node tools/cli.ts replay tools/samples/fall-preview.ndjson --url http://localhost:8080/ingest
```

NDJSON은 빈 줄과 `#` 주석을 허용한다. 각 데이터에는 0 이상의 숫자 `ts`가 필요하며, 타임스탬프는 이전 줄보다 과거일 수 없다.

## B1 연결 지점

CLI는 기본적으로 ingest JSON을 표준 출력으로 내보내며, `--url`을 주면 같은 레코드를 HTTP POST로 전송한다. HTTP writer는 빠르게 들어온 레코드도 순서를 유지해 전송한다. 생성기와 리플레이 코어는 전송 방식과 분리돼 있다.

## 평가 (evaluate) — 고전 감지기 베이스라인 성적

정규화 CSV(`ml/normalize_falls.py` 출력)의 라벨된 trial을 고전 낙상 감지기(`server/detection/fall.ts`)에 통째로 흘려 혼동행렬을 뽑는다. 이 감지기의 성적이 곧 AI가 넘어야 할 기준선(spec 04 §6)이고, AI 감지기도 같은 도구로 비교한다.

```bash
node tools/cli.ts evaluate ml/datasets/_normalized/waist_falls_50hz.csv
```

판정 수준은 하나다(DETECTED). 고전 감지기가 `fall_detected`를 냈는가 = 충격(impactG)을 잡았는가이며, 순수 신호 분별력을 본다. AI는 이 도구를 안 거친다 — 캐스케이드까지 포함한 성적은 `ml/train.py`의 LOSO OOF(`ml/_out/train_loso.txt`)를 본다.

CSV는 g 단위, 감지기는 m/s²를 기대하므로 도구가 gravity를 곱해 넣는다. trial마다 새 감지기 인스턴스를 써서 상태가 새지 않는다. 대용량 CSV는 한 줄씩 스트리밍하며 trial 단위로 끊어 평가한다(메모리 안전).

### 임계 스윕(트레이드오프 곡선)

`--sweep`은 감지기의 임계값을 각각 단독으로 흔들어(1D 스윕, 나머지는 기본값) 민감도-특이도-헛경보 곡선을 낸다. 감지 여부를 실제로 바꾸는 것은 `impactG` 하나이고, freefall 계열은 이벤트의 표시 플래그만 바꾸므로 `flag-only`로 나온다. 스윕 대상 위치는 기본 waist(다회 패스용으로 해당 위치 trial만 메모리에 타입배열로 압축 캐시), `all`이면 전체.

```bash
node tools/cli.ts evaluate ml/datasets/_normalized/waist_falls_50hz.csv --sweep --json tools/results/waist_eval.json
```

파라미터별 affects 표기: `candidate+confirmed`(impactG) / `confirmed`(settleMs·immobilityMs·immobilityBandG·movementG) / `flag-only`(freefallG·freefallWindowMs — 감지를 게이트하지 않고 이벤트의 freefall 표시 플래그만 바꿈, 곡선 불변). `--json`으로 기계가독 결과도 저장한다.

`tools/results/`에 최근 실행 결과(허리·마스터)를 저장해 둔다.

## 클립 (clip) — 데모 주입용 실신호 잘라내기

대시보드의 낙상 주입 버튼은 데이터셋에서 잘라낸 **실제 가속도 구간**을 흘린다. 그 구간을 만드는 도구다. 만들어진 클립은 `server/inject/clips/*.json`으로 커밋되고, 원본 마스터 CSV(3.7GB)는 git에 없으므로 이 명령이 유일한 재생성 경로다.

무엇을 왜 골랐는지는 레시피 파일 `tools/clips.json`에 남는다. 클립을 바꾸려면 레시피를 고치고 다시 돌린다.

```bash
node tools/cli.ts clip ml/datasets/_normalized/falls_all_50hz.csv
```

레시피 하나만, 또는 파일을 쓰지 않고 결과만 보려면:

```bash
node tools/cli.ts clip <csv> --only false-alarm --dry-run
```

자르는 기준은 두 가지다.

- 앞은 **첫 이벤트 인덱스 − (특징창 150샘플 + 여유)**. 여기서 더 자르면 AI가 채점할 때 링버퍼가 안 차서 가장자리 복제로 메우고(`detection/cascade.ts`), 원본에서 기각됐던 충격이 클립에서는 통과해 버린다. 기준점은 캐스케이드가 아니라 **고전 단독** 이벤트까지 합쳐서 잡는다 — AI가 기각한 자리도 클립 안에 들어와야 하기 때문이다.
- 뒤는 마지막 이벤트 + 여유.

자른 뒤 캐스케이드와 고전 단독 양쪽으로 다시 흘려 이벤트 순서가 원본 trial과 같은지 확인하고, 다르면 던진다. 결과 판정은 클립 JSON의 `expect`에 박혀 `test/inject/clips.test.ts`가 매번 대조한다 — 데모 화면의 문구와 실제 감지 결과를 묶어 두는 장치다.

## 테스트

```bash
node --test test/tools/*.test.ts
```
