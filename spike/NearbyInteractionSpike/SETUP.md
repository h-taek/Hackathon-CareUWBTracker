# NI 스파이크 — 아이폰↔애플워치 단일 세션 UWB 실측

목적 한 줄: **"아이폰↔애플워치 Nearby Interaction이 거리값을 주는가, 몇 Hz로, 얼마나 정확한가"를 폰1+워치1로 실측**한다.
이게 통과해야 나중에 폰2+워치1(앵커2+태그1) 2앵커 삼각측량으로 넘어간다. (근거: `docs/spec/06_hardware.md` 4.4절)

이 단계에서 검증 못 하는 것: 워치가 **앵커 2대와 동시** 세션 유지하는지 → 그건 2번째 폰이 있어야 함(다음 단계).

---

## 사전 조건
- 아이폰 1대(iPhone 11 이상, U1/U2), Apple Watch Series 6, **둘이 서로 페어링되어 있어야 함**(토큰 교환을 WatchConnectivity로 하기 때문).
- Mac + Xcode. 무료 Apple ID면 됨(유료 개발자 계정 불필요, 단 7일마다 재서명).
- **실기기 전용.** NI/워치는 시뮬레이터에서 안 됨.

---

## Xcode 프로젝트 만들기 (약 10분)

1. **새 iOS 앱 생성**: Xcode → New Project → iOS → App.
   - Interface: **SwiftUI**, Language: **Swift**.
   - Product Name 예: `NISpike`. (자동 생성되는 `ContentView.swift`, `NISpikeApp.swift`는 뒤에서 지운다.)

2. **Watch 타깃 추가**: File → New → Target → **Watch App**(“Watch App for iOS App”이 아니라 페어링되는 Watch App). 같은 프로젝트에 붙이고 Product Name 예: `NISpike Watch App`.
   - 이렇게 하면 폰-워치가 companion으로 묶여 WatchConnectivity가 자동 성립한다.

3. **자동 생성된 기본 파일 삭제**: iOS 타깃과 Watch 타깃 각각의 기본 `ContentView.swift` / `*App.swift`를 **Move to Trash**. (우리가 넣을 파일과 이름/@main이 충돌한다.)

4. **이 폴더의 소스 추가** (Add Files to “NISpike”…, *Copy items if needed* 체크):
   | 파일 | 추가할 타깃 |
   |---|---|
   | `Shared/NIRangingManager.swift` | **iOS + Watch 둘 다** 체크 |
   | `Shared/ContentView.swift` | **iOS + Watch 둘 다** 체크 |
   | `iOS/NISpikeApp_iOS.swift` | **iOS만** |
   | `watchOS/NISpikeApp_watchOS.swift` | **Watch만** |

   > 파일 선택 시 하단 Target Membership 체크박스로 조정. 나중에도 우측 File Inspector → Target Membership에서 바꿀 수 있다.

5. **권한 문자열(Privacy) 추가** — 두 타깃 모두:
   - 타깃 선택 → **Info** 탭 → 키 추가:
   - **Privacy - Nearby Interaction Usage Description** (`NSNearbyInteractionUsageDescription`)
   - 값 예: `실내 위치 측정을 위해 근처 기기와의 거리를 사용합니다.`
   - ⚠️ 이 키가 없으면 세션이 조용히 안 뜬다. iOS 타깃 + Watch 타깃 **각각** 넣을 것.
   - ➕ **네트워크 채널을 쓰므로 로컬 네트워크 권한도 필요**: `NSLocalNetworkUsageDescription`(문자열) + `NSBonjourServices` 배열에 `_nispike._tcp`. 아래 "companion 문제 해결" 절 참고(현 프로젝트엔 이미 주입·검증됨). 이 채널 덕에 워치 앱이 companion이 아니어도(watch-only여도) 토큰 교환이 된다 — step 2의 companion 조건은 더 이상 필수 아님.

6. **서명(Signing & Capabilities)** — 두 타깃 모두:
   - Team: 본인 Apple ID(Personal Team) 선택. Bundle ID가 중복되면 살짝 바꾼다.
   - 특별한 Capability나 Entitlement는 **불필요**(NI 피어 세션과 WatchConnectivity는 usage string만 있으면 됨).

7. **빌드/실행**:
   - iOS scheme → 아이폰 실기기 선택 → Run.
   - Watch scheme → 워치 실기기 선택 → Run. (첫 설치 시 워치에서 “신뢰” 필요할 수 있음. 무료 서명은 워치 배포가 느리니 몇 분 기다린다.)
   - 두 앱 모두 화면에 **떠 있는 상태**로 둔다(포그라운드). 처음 실행 시 각 기기에서 “Nearby Interaction 허용” 팝업 → 허용.

---

## 동작 원리 (요약)
- 각 기기가 `NISession`을 만들고 자신의 `discoveryToken`을 **네트워크 채널(`NetworkTokenChannel`)**로 상대에게 보냄.
  - Bonjour(`_nispike._tcp`)로 서로를 찾고, `includePeerToPeer = true`라 **라우터/공유 Wi-Fi 없이도** AWDL(에어드롭식 직접 무선링크)로 붙는다. WatchConnectivity·companion 페어링 불필요.
  - Phase 1(앵커 폰 2대 + 워치)에서도 각 노드가 이 채널을 그대로 써서 확장된다(비페어링 2번째 폰과도 동작 = 이 방식이 유일 정답).
- 상대 토큰을 받으면 `NINearbyPeerConfiguration`으로 `session.run` → `didUpdate`에서 `distance`(m) 수신.
- 화면: 거리(m) / 업데이트율(Hz) / 누적 콜백 수 / 피어연결 상태 / 상태메시지.
- 워치·U2 아이폰은 `direction`이 nil이지만 우리 방식은 **거리만** 쓰므로 무관.

---

## 실측 & 기록 (이게 스파이크의 산출물)

두 기기를 마주 보게 두고 아래를 기록. 결과는 `docs/PROGRESS.md`(완료 기록)와 `HANDOFF.md`(다음 스텝)에 반영한다.

| 항목 | 확인 방법 | 결과 |
|---|---|---|
| **거리값이 뜨는가 (핵심 PASS/FAIL)** | 두 앱 실행 후 화면에 `x.xx m`가 뜨는지 | ☐ |
| 정상 업데이트율 (Hz) | 고정 상태에서 Hz 값 관찰 | ___ Hz |
| 정확도 @1m | 줄자로 1.0m 띄우고 화면값 비교 | 화면 ___ m |
| 정확도 @3m | 줄자로 3.0m | 화면 ___ m |
| 정확도 @5m | 줄자로 5.0m | 화면 ___ m |
| 최대 사거리 | 멀어지며 값이 끊기는 거리 | ___ m |
| **워치 화면 슬립 시** | 손목 내리거나 워치 화면 꺼질 때 Hz가 0 되는지 | ☐ 멈춤 / ☐ 유지 |
| 드롭 후 회복 | 사거리 밖 나갔다 복귀 시 자동 재개되는지 | ☐ |
| 벽/사람 가림 영향 | 사이에 몸/벽 넣었을 때 변화 | 메모: |

### 판정 기준
- **PASS**: 거리값이 안정적으로 뜨고 정확도 오차 대략 ±0.3m 이내, 수 Hz 이상 → 폰2+워치1(2앵커) 단계로 진행.
- **부분**: 뜨긴 하는데 Hz 낮거나 워치 슬립 시 자주 끊김 → 워치 슬립 유지 트릭 필요(항상표시/포그라운드 유지), 그래도 애매하면 폰3 폴백 검토.
- **FAIL**: 아이폰↔워치 거리값 자체가 안 뜸 → 워치 경로 폐기, **폰3(아이폰 다중세션은 확인됨)**으로 회귀. 이 경우 워치 대신 아이폰 3대로 앵커2+태그1 재설계.

---

## 흔한 문제
- **거리값이 안 뜸**: (1) 두 기기에서 **로컬 네트워크 권한 팝업을 허용**했는지(iOS는 첫 실행 시 뜸) + Nearby Interaction 팝업 허용했는지 (2) 두 앱 모두 포그라운드인지 (3) 두 기기가 같은 Wi-Fi거나 최소한 Wi-Fi·Bluetooth가 켜져 있는지(AWDL 직접링크는 Wi-Fi/BT 라디오를 씀) (4) 콘솔 로그 `[PHONE]/[WATCH]` 확인 — `browser ready`/`listener ready`(탐색 시작), `내 토큰 송신`/`상대 토큰 수신`(교환 성공) 순으로 찍혀야 함.
- **`browser`/`listener`는 뜨는데 연결이 안 됨**: 네트워크 격리 환경(게스트 Wi-Fi, AP isolation)일 수 있음. Wi-Fi를 끄고 Bluetooth만 켜서 AWDL 직접링크로 붙는지 시도. 또는 둘을 같은 개인 핫스팟/공유기에 둔다.
- **한쪽(특히 워치)만 `connection ready`가 안 뜨고 `Path was denied by NECP policy, interface: ipsec1` 로그가 도배됨 (2026-07-17 실제 겪음)**: 그 기기에 **VPN 또는 iCloud 개인정보 보호 릴레이**가 켜져 있어 로컬/피어 경로를 막는 것. `ipsec1`은 VPN 터널 인터페이스다. 조치: (1) 해당 기기 **VPN OFF**(설정 > VPN), (2) 폰 설정 > Wi-Fi > (ⓘ) > **"IP 주소 추적 제한(개인정보 릴레이)" OFF**, (3) 워치 설정 > 개인정보 보호 및 보안 > **로컬 네트워크 > 앱 ON**(권한 자체가 없으면 NECP가 전 경로를 막는다). 증상 확인법: 한쪽은 `상대 토큰 수신`이 되는데 상대의 토큰 크기가 아니라 **자기 토큰 크기만** 되풀이되면(예: 폰 343B만, 워치 311B가 안 옴) 실제 상대와는 한 번도 안 붙은 것.
- **워치 설치 실패/느림**: 무료 서명은 워치 배포가 느림. 워치가 충전 중 + 아이폰과 가까이 + 잠금 해제 상태로 몇 분 대기.
- **7일 뒤 앱 안 열림**: 무료 서명 만료. Xcode에서 재설치.
- **Hz가 튐**: 표시는 최근 2초 rolling 평균이라 초반엔 낮게 나옴. 10초쯤 안정화 후 읽기.

---

## Phase 1 — 2세션 테스트 (2번째 폰 확보 시 바로 실행) ✅ 코드 스테이징 완료

**코드는 이미 다 짜여 있고 양 타깃(iOS/watchOS) 컴파일도 통과**했다(`Shared/MultiPeerNIManager.swift`, `Phase1ContentView.swift`, `RootView.swift` + `_phase1_phone2phone/NetworkTokenChannel.swift`를 범용 메시지 파이프로 일반화). 폰2가 오면 **역할 버튼만 누르면** 된다. 앱 켜면 첫 화면에서 `Phase 1 · 2세션 테스트` 선택 → 각 기기에서 자기 역할 버튼 탭.

핵심 원리(왜 이렇게): NI는 상대 1명당 세션 1개다. 그래서 태그는 앵커마다 세션을 따로 연다. 각 세션은 자기 토큰을 만들므로 토큰에 "누구→누구(from/to)" 주소를 붙여 보낸다. **워치는 companion 폰(WCSession) 1대하고만 통신 가능**하므로, 2번째 앵커(폰2)의 토큰은 **폰1이 중계**한다(워치→WC→폰1→네트워크→폰2, 반대도 동일). UWB 거리 측정 자체는 토큰만 교환되면 두 라디오가 직접 잰다 — 네트워크는 "전화번호(토큰) 교환"에만 쓰인다.

**변수 분리를 위해 2단계로 검증한다:**

**A단계 — 폰1=허브(중계 없음). "다중세션 코드가 맞나"를 신뢰되는 폰에서 먼저 확인.**
- 폰1: `A · 폰1=허브(2세션)` / 워치: `A · 워치=태그` / 폰2: `A · 폰2=앵커`
- 폰1이 워치·폰2 2세션을 동시에 든다. 폰1 화면에 **두 줄(TAG, ANCHOR2) 거리**가 다 뜨면 PASS.
- (여기서 실패하면 워치 이전에 우리 코드/네트워크 문제 → 워치 변수 없이 디버깅)

**B단계 — 워치=태그(폰1 중계). 진짜 리스크(워치 2세션) 확인.**
- 워치: `B · 워치=태그(2세션)` / 폰1: `B · 폰1=앵커+중계` / 폰2: `B · 폰2=앵커`
- 워치 화면에 **두 줄(ANCHOR1, ANCHOR2) 거리**가 동시에 뜨면 → **워치 2세션 가능 = 워치가 태그로 확정**.
- 한 줄만 뜨고 다른 줄이 `-- m`에서 안 오르면 → 워치가 2세션을 못 드는 것(리스크 4.4 현실화) → **폴백: 폰3대(앵커2+태그폰1)**, 워치는 태그에서 제외.

판정: 두 거리 모두 안정적으로 갱신(±0.3m·수 Hz)되면 삼각측량 진행 가능.
주의: A/B 모두 **세 기기 앱을 아이콘 탭으로 포그라운드** + **워치 화면 깨워두기** 원칙은 Phase 0과 동일. 폰↔폰 네트워크는 같은 Wi-Fi(또는 AWDL 직접) + VPN/비공개릴레이 OFF.
미검증 주의: 이 코드는 폰2가 없어 **실기기 실행은 아직 안 해봤다**. 컴파일만 통과 — 첫 실행 시 토큰 라우팅/중계 타이밍은 Phase 0처럼 몇 번 다듬어야 할 수 있다.

---

## ✅ [해결 2026-07-17] 워치는 WCSession(companion)으로 확정 — 거리 수신 성공

아래 "네트워크 채널로 전환"은 **애플워치에선 플랫폼 차원에서 막힌다**. watchOS는 NWBrowser/Bonjour/NWConnection 같은 로컬 네트워킹을 일반 앱에서 금지한다(Apple 엔지니어가 "오디오 스트림 세션 밖에선 동작 안 함"이라 확인. 실기기에서 워치가 `Path was denied by NECP policy, interface: ipsec1`로 전 경로 차단됨). 워치가 폰과 통신하는 유일한 공식 채널은 **WatchConnectivity(WCSession, companion 링크)**뿐이다(IP가 아니라 VPN/NECP 무관).

**→ 그래서 워치 타깃을 companion으로 재생성하고(“Watch App for Existing iOS App”) 매니저를 WCSession으로 되돌렸고, 실기기에서 아이폰↔워치 NI 거리 수신에 성공했다.** 네트워크 채널 코드(`NetworkTokenChannel.swift`)는 폐기하지 않고 `_phase1_phone2phone/`에 파킹 — **Phase 1의 폰↔폰 구간**에 재사용한다(워치는 companion 폰 1대만 직접 대화 가능, 2번째 앵커 폰과는 companion 폰이 중계). 상세는 `docs/PROGRESS.md` "[Phase 0 통과]" 절 참조. 아래 "네트워크 채널" 섹션은 폰↔폰 참고용 이력으로만 남긴다.

### 실기기 실행 팁 (반복 시)
- 두 앱을 **아이콘 탭**으로 켠다(디버거로 한쪽만 켜면 다른 쪽이 SIGKILL로 죽어 동시 실행이 안 됨). 워치 로그를 보려면 Watch scheme만 Xcode Run + 폰은 아이콘 탭.
- **워치 화면을 깨워둔다**(손목 들기/탭). 화면이 자면 워치 NI 세션이 멈춰 폰 `업데이트`도 0에서 안 오른다 = 이게 Phase 0에서 정량 기록할 "워치 슬립 거동".
- 두 기기 **~1m 이상** 벌린다(UWB는 수 cm면 값 안 남).
- "● 피어 연결됨"인데 `업데이트 0`이면 stale-token 잔재 — 두 앱 완전 종료 후 재실행하면 최신 토큰으로 자동 재-run 된다.

## companion 문제 해결 — 네트워크 채널로 전환 (2026-07-17) *(위 정정 참고: 워치 구간은 폐기)*

이전 세션의 막힌 지점(폰↔워치 `WCSession counterpart app not installed` → 워치 앱이 watch-only라 WatchConnectivity가 companion 짝을 못 찾음)을 **토큰 교환 채널 자체를 바꿔서** 해결했다. WatchConnectivity를 버리고 `NetworkTokenChannel`(Bonjour + AWDL peer-to-peer)로 교체했으므로 companion 페어링 자체가 불필요해졌다. 이 방식은 Phase 1(비페어링 앵커 폰 2대)에서 어차피 유일한 정답이라 버려지는 작업이 아니다.

### 코드 변경 (소스 정본 `spike/.../Shared/`에 반영, 빌드본 `~/Developer/NISpike`에 복사 완료)
- **신규** `NetworkTokenChannel.swift`: 대칭 피어(각 기기가 광고+탐색 동시). 연결되면 길이접두 프레임으로 `NIDiscoveryToken` 아카이브를 주고받음. `includePeerToPeer=true`.
- **개편** `NIRangingManager.swift`: WatchConnectivity/WCSession 전부 제거 → `NetworkTokenChannel` 사용. 자기 자신을 Bonjour로 발견해 자기 토큰을 받는 자기루프를 막는 가드 포함(`data != myTokenData`). 대칭 피어라 커넥션 2개일 수 있어 중복 토큰 무시(`peerConnected` 가드).
- `ContentView.swift`는 변경 없음(같은 @Published 상태 사용).

### 빌드 설정 변경 (빌드본 `NISpike.xcodeproj`에만 존재 — 정본은 아래 Config/ 파일)
- 네트워크 채널은 권한 키가 없으면 **조용히 아무 기기도 못 찾는다**(예전 companion처럼 silent fail). 그래서 두 타깃(iOS·watch) 모두에 자동 주입해 뒀다:
  - `INFOPLIST_KEY_NSLocalNetworkUsageDescription`(빌드 설정) — 문자열이라 바로 주입됨.
  - `NSBonjourServices` 배열(`_nispike._tcp`) — INFOPLIST_KEY로는 배열이 안 들어가서, 부분 Info.plist(`Config/iOS-Info.plist`, `Config/watchOS-Info.plist`)를 만들고 각 타깃 `INFOPLIST_FILE`로 지정 → `GENERATE_INFOPLIST_FILE=YES`가 자동 키와 **병합**한다. iOS·watch 둘 다 빌드해 `NSBonjourServices`가 배열로, 기존 자동생성 키(NI 권한 등)도 유지됨을 확인함.
- `NetworkTokenChannel.swift`는 워치 타깃 멤버십에도 추가함(pbxproj `membershipExceptions`).
- **`Config/` 부분 Info.plist는 정본에도 미러링해 뒀다**(`spike/.../Config/`). 빌드본을 갈아엎으면 이 두 파일을 다시 `~/Developer/NISpike/Config/`로 두고 각 타깃 `INFOPLIST_FILE`에 지정할 것.

### 검증 상태
- 컴파일: iOS(iphoneos)·watchOS(watchsimulator) **둘 다 BUILD SUCCEEDED**. Network.framework peer-to-peer API가 watchOS에서도 가용함 확인.
- **아직 안 한 것(다음): 실기기 2대에서 실제로 토큰이 오가고 NI가 거리값을 주는지.** 위 실측 표를 채우는 게 Phase 0 최종 답이다.

### 정본/빌드본 이원 운영 (재확인)
- 소스 정본 `spike/NearbyInteractionSpike/`(Swift + Config + SETUP), 빌드본 `~/Developer/NISpike`(pbxproj 포함). Swift/Config 편집 시 빌드본으로 복사해야 함(iCloud 빌드 캐시 충돌 회피 목적의 분리).
