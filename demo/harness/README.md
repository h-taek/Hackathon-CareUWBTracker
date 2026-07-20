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

## 테스트

```bash
node --test demo/harness/*.test.js
```
