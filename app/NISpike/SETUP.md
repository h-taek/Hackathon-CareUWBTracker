# NI 스파이크 — 최종 측위·텔레메트리 테스트 (워치 태그 + 앵커폰 1~2대 + 서버)

목적 한 줄: **애플워치(태그)가 앵커 폰과 UWB 거리 + 가속도를 재서 메인폰이 서버로 ingest POST**하는 최종 경로를 실측한다.
앵커 폰이 **1대든 2대든** 동작한다 — 2대면 서버가 삼각측량으로 (x,y) 좌표까지, 1대면 거리·가속도만(낙상 판정은 가속도만으로 별도).

> **빌드 — 이 폴더가 곧 빌드 프로젝트다.** 소스=빌드가 `app/NISpike/` 한 곳이다. GUI(Xcode) 없이:
> - `./run.sh` — 빌드 → 아이폰 설치 → 실행 → 콘솔 로그. 워치는 companion 전파를 기다리지 않고 직접 설치한다.
> - `./run.sh build` 컴파일만 · `--list` 기기 목록 · `--device <이름|UDID>` 대상 폰 지정 · `--no-watch` 워치 건너뛰기 · `--watch-only` 워치만 재설치. 전체는 `./run.sh --help`.
> - **폰이 두 대 이상 페어링돼 있으면 `--device`를 반드시 쓴다.** 메인폰은 USB를 뽑아도 목록에 남아, 없이 실행하면 첫 번째 기기에 깔린다.
> - DerivedData는 기본값(`~/Library`, iCloud 밖).

---

## 사전 조건
- **워치**: Apple Watch Series 6 이상(U1/U2), 아이폰과 페어링됨(토큰 교환에 WatchConnectivity 사용).
- **앵커 폰**: iPhone 11 이상(U1/U2) 1~2대. 메인폰은 워치와 페어링된 기기. 서브폰(2대째)은 페어링 불필요(폰↔폰은 네트워크 채널).
- Mac + Xcode. 무료 Apple ID면 됨(7일마다 재서명). **실기기 전용**(시뮬레이터 불가).
- 서버: `npm start` 실행 후 대시보드 `http://localhost:8080`.

---

## 역할과 화면 (앱을 켜면 바로 이 화면 하나)

앱 진입 = 최종 화면(IngestView). 기기별로:

| 기기 | 역할 | 화면에서 |
|---|---|---|
| 워치 | 태그(TAG) | `워치 연결 시작` 탭 → 앵커별 거리 + 가속도 측정·전송 |
| 메인폰 | 게이트웨이+중계 | 역할 `메인폰(게이트웨이)` 선택 → `워치 연결 시작` → `서버 전송 시작` |
| 서브폰 | 앵커2 (2대일 때만) | 역할 `서브폰(앵커2)` 선택 → `워치 연결 시작` (서버 전송 없음) |

- **버튼 2개는 독립**이다: `워치 연결`(NI/거리 측정 링크)과 `서버 전송`(ingest POST 링크)을 따로 켜고 끈다. 예: 거리만 보고 싶으면 워치 연결만, 서버로도 보내려면 서버 전송도 켠다.
- **최신화 보장**: 시작할 때마다 세션·네트워크 채널을 새로 만든다(새 토큰 → 묵은 토큰 latch 방지). 정지하면 세션·연결·거리 상태를 전부 비운다. 갱신이 1.5초 이상 끊긴 거리는 워치독이 자동으로 `—` 처리(얼어붙은 옛 거리 방지).

### 1대(메인폰만) 테스트
서브폰 없이 워치+메인폰만. 워치가 phoneSub 세션도 열지만 상대가 없어 그 거리는 계속 `—` → 프레임엔 phoneMain만 실림. 서버 로그: `ranges: phoneMain=1.23m phoneSub=-  pos=(-, -)` (에러 아님, 정상 축약).

### 2대(메인폰+서브폰) 테스트
서브폰까지 켜면 워치가 두 세션(phoneMain·phoneSub) 유지 → 프레임에 두 거리 → 서버가 삼각측량 → `pos=(x, y)`. 서브폰 토큰은 메인폰이 워치↔서브폰 사이에서 중계한다(워치→WC→메인폰→네트워크→서브폰).

---

## 실측 & 기록

두 기기(또는 세 기기)를 벌려 두고 아래를 기록. 결과는 먼저 `docs/research/`에 정리한 뒤 `docs/PROGRESS.md`/`HANDOFF.md`에 반영.

| 항목 | 확인 방법 | 결과 |
|---|---|---|
| 거리값이 뜨는가 | 화면 앵커 줄에 `x.xx m` | ☐ |
| 업데이트율 (Hz) | 고정 상태 Hz 관찰 | ___ Hz |
| 정확도 @1m/@3m/@5m | 줄자로 띄우고 화면값 비교 | ___ / ___ / ___ m |
| 2앵커 좌표 (2대일 때) | 서버 로그 `pos=(x,y)` 갱신 | ☐ |
| 워치 화면 슬립 시 | 손목 내릴 때 전송 유지되는지(운동 세션 keep-alive) | ☐ 유지 / ☐ 멈춤 |
| 드롭 후 회복 | 사거리 밖→복귀 시 자동 재개 | ☐ |
| 서버 수신 | 대시보드/콘솔 `[ingest]` 로그 | ☐ |

---

## 흔한 문제
- **거리값이 안 뜸**: (1) 각 기기 **Nearby Interaction 팝업 + 로컬 네트워크 권한**을 허용했는지 (2) 관련 앱이 포그라운드인지(워치는 화면 깨워두기) (3) Wi-Fi·Bluetooth 켜짐(AWDL 직접링크가 라디오 사용).
- **너무 가까우면 값이 안 남/고정됨**: UWB는 수 cm(≈10cm 미만)에선 신뢰 거리가 안 나온다. **기기를 50cm 이상 벌리고** 시작할 것. 예전 "0.04m 고정"이 이 케이스(시작 시 너무 붙어 바닥값 latch). 이제 워치독이 끊긴 값을 `—`로 비우지만, 시작 시 벌려두는 게 최선.
- **`Path was denied by NECP policy, interface: ipsec1` 도배(폰↔폰 안 붙음)**: 그 기기에 **VPN 또는 iCloud 개인정보 릴레이**가 켜져 로컬/피어 경로를 막음. 조치: VPN OFF, 설정>Wi-Fi>(ⓘ)>"IP 주소 추적 제한" OFF, 로컬 네트워크 권한 ON.
- **"● 연결됨"인데 거리 0에서 안 오름**: 묵은 토큰 잔재 가능 — `워치 연결 정지` 후 다시 시작하면 새 세션·새 토큰으로 재수렴한다(시작마다 새로 만들므로).
- **서버 `.local` 타임아웃**: OS mDNS 캐시가 안 갱신된 경우. 서버 host를 사설 IP(숫자)로 바꿔 입력하면 붙는다.
- **워치 설치 느림/7일 만료**: 무료 서명 특성. 워치 충전+가까이+잠금해제로 대기, 만료 시 재설치.
- **새 기기에서 앱이 안 열림(신뢰되지 않은 개발자)**: 무료 서명 앱은 기기마다 최초 1회 승인이 필요하다. 그 기기에서 설정 > 일반 > VPN 및 기기 관리 > 개발자 앱 > 계정 신뢰.
- **워치 설치가 `0xe8008012`로 실패**: 프로비저닝 프로파일에 그 워치 UDID가 없다. 워치를 destination으로 한 번 빌드해 등록시킨다 — `xcodebuild -scheme 'NISpike Watch App Watch App' -destination 'id=<워치 UDID>' -allowProvisioningDeviceRegistration build` 후 `./run.sh --watch-only`.
- **워치가 `tunnelState: disconnected`**: 워치는 USB가 없어 LAN 터널로만 붙는다. 워치를 충전기에 올리고 잠금해제한 뒤 같은 Wi-Fi인지 확인한다. 터널이 없으면 `run.sh`가 45초를 버리기 전에 먼저 알린다.
- **서버 주소가 옛 맥 이름**: 앱의 `serverHost` 기본값은 `IngestManager.swift`에 하드코딩돼 있고 저장되지 않는다(앱 재실행 시 복귀). 맥을 바꾸면 그 값을 같이 고친다. 현재 맥 이름은 `scutil --get LocalHostName`.
- **Hz가 튐**: 최근 2초 rolling 평균이라 초반엔 낮게 나옴 — 10초쯤 안정화 후 읽기.

---

## 권한 설정 (프로젝트에 이미 주입·검증됨, 참고용)
- **Nearby Interaction**: `NSNearbyInteractionUsageDescription` — 두 타깃 모두. 없으면 세션이 조용히 안 뜬다.
- **로컬 네트워크**(폰↔폰 토큰 채널·서버 POST): `INFOPLIST_KEY_NSLocalNetworkUsageDescription`(빌드 설정) + `NSBonjourServices` 배열 `_nispike._tcp`(`Config/iOS-Info.plist`) + ATS `NSAllowsLocalNetworking`(평문 HTTP ingest 허용, 로컬 한정).
- 특별한 Capability/Entitlement는 불필요(NI 피어 세션·WatchConnectivity는 usage string만 있으면 됨).

## 동작 원리 (요약)
- NI는 상대 1명당 세션 1개다. 워치는 앵커마다 세션을 따로 열고(`links[peerID]`), 각 세션의 discoveryToken에 "누구→누구(from/to)" 주소를 붙여(`AddressedToken`) 교환한다.
- 워치는 companion 폰(WCSession)하고만 통신 가능 → 서브폰 토큰은 **메인폰이 중계**(`relays=true`). UWB 거리 측정 자체는 토큰만 교환되면 두 라디오가 직접 잰다.
- 코드: `IngestManager.swift`(다중세션+중계+텔레메트리+POST), `NetworkTokenChannel.swift`(폰↔폰 Bonjour/AWDL 파이프, iOS 전용), `TelemetryFrame.swift`(워치→폰 데이터 계약).
