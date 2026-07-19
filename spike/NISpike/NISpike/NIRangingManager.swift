import Foundation
import NearbyInteraction
import WatchConnectivity
import Combine

/// 아이폰 <-> 애플워치 단일 세션 UWB 레인징 스파이크 매니저.
/// - 목적: "아이폰↔워치 Nearby Interaction이 거리값을 주는가 / 몇 Hz / 정확도" 실측.
/// - 토큰 교환: **WatchConnectivity(WCSession)**. companion 링크(IP 아님)라 VPN/NECP와 무관.
///   (watchOS는 Bonjour/로컬 네트워크를 일반 앱에서 금지 → 워치의 유일한 폰 연결 채널이 WCSession.
///    폰↔폰 네트워크 교환은 별도 `NetworkTokenChannel`로 Phase 1에서 사용. PROGRESS "핵심 발견" 참조.)
/// - iOS/watchOS 두 타깃에 이 파일 하나를 공유(add to both targets)한다. API가 동일하다.
final class NIRangingManager: NSObject, ObservableObject {

    // MARK: UI 상태
    @Published var distance: Float? = nil     // 미터. 콜백마다 갱신, 순간적으로 nil 가능
    @Published var updateHz: Double = 0        // 최근 2초 rolling 업데이트율
    @Published var totalUpdates: Int = 0       // 세션 시작 후 누적 distance 콜백 수
    @Published var peerConnected: Bool = false // 피어 토큰 수신 완료 여부
    @Published var status: String = "시작 대기"

    // MARK: 내부
    private var niSession: NISession?
    private var wcSession: WCSession?
    private var lastConfig: NINearbyPeerConfiguration?
    private var updateTimestamps: [Date] = []
    private var retryTimer: Timer?
    private var started = false   // onAppear 중복 호출 등으로 세션이 여러 개 뜨는 것 방지
    private var runningPeerTokenData: Data?   // 지금 레인징 돌고 있는 상대 토큰(묵은 토큰이 새 토큰으로 덮이도록 추적)

    #if os(watchOS)
    let deviceRole = "WATCH"
    #else
    let deviceRole = "PHONE"
    #endif

    // MARK: 시작
    func start() {
        guard !started else { return }
        guard NISession.isSupported else {
            status = "이 기기는 Nearby Interaction 미지원(U1/U2 칩 없음)"
            return
        }
        setupNISession()
        setupWCSession()
        started = true
        status = "세션 시작, 토큰 교환 대기"
        // 타이밍/묵은토큰 문제를 이기려고, "실제 거리 업데이트가 들어올 때까지" 내 최신 토큰을 반복 재전송한다.
        // (peerConnected가 아니라 totalUpdates 기준: 묵은 토큰으로 '연결됨'만 뜬 상태에서도 계속 최신 토큰을 밀어넣기 위함)
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] t in
            guard let self = self else { t.invalidate(); return }
            if self.totalUpdates > 0 { t.invalidate(); return }
            self.shareTokenIfPossible()
        }
    }

    private func setupNISession() {
        let session = NISession()
        session.delegate = self
        niSession = session
        shareTokenIfPossible()   // WC가 이미 활성이면 즉시 전송, 아니면 활성 콜백에서 재시도
    }

    private func setupWCSession() {
        guard WCSession.isSupported() else {
            status = "WatchConnectivity 미지원"
            return
        }
        let wc = WCSession.default
        wc.delegate = self
        wc.activate()
        wcSession = wc
    }

    // MARK: 토큰 송신 (내 토큰 -> 상대)
    private func shareTokenIfPossible() {
        guard let token = niSession?.discoveryToken else { return }
        guard let wc = wcSession, wc.activationState == .activated else { return }
        do {
            let data = try NSKeyedArchiver.archivedData(withRootObject: token,
                                                        requiringSecureCoding: true)
            if wc.isReachable {
                // 양쪽 앱이 켜져 있을 때: 즉시 전달
                wc.sendMessageData(data, replyHandler: nil) { [weak self] err in
                    self?.log("sendMessageData 실패(\(err.localizedDescription)) → userInfo 폴백")
                    wc.transferUserInfo(["niToken": data])
                }
            } else {
                // 상대 앱이 아직 안 켜졌을 때: 큐잉해서 열리면 전달
                wc.transferUserInfo(["niToken": data])
            }
            // 가장 신뢰도 높은 백그라운드 채널: 최신 상태로 항상 덮어써 전달(도달/포그라운드 무관)
            try? wc.updateApplicationContext(["niToken": data])
            log("내 토큰 전송 시도(reachable=\(wc.isReachable))")
        } catch {
            log("토큰 아카이브 실패: \(error)")
        }
    }

    // MARK: 토큰 수신 (상대 토큰 -> 레인징 시작)
    private func didReceiveTokenData(_ data: Data) {
        // 같은 토큰으로 이미 돌고 있으면 무시. 다른(=더 최신) 토큰이 오면 그걸로 다시 run → 묵은 토큰이 최신으로 덮인다.
        guard data != runningPeerTokenData else { return }
        guard let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self,
                                                                  from: data) else {
            log("피어 토큰 언아카이브 실패")
            return
        }
        runningPeerTokenData = data
        let config = NINearbyPeerConfiguration(peerToken: token)
        lastConfig = config
        niSession?.run(config)
        DispatchQueue.main.async {
            self.peerConnected = true
            self.status = "레인징 시작 (peer \(data.count)B)"
        }
        log("피어 토큰 수신(\(data.count)B), session.run")
    }

    // MARK: Hz 계산
    private func recordUpdate() {
        let now = Date()
        updateTimestamps.append(now)
        updateTimestamps.removeAll { now.timeIntervalSince($0) > 2.0 }  // 최근 2초만 유지
        let span = updateTimestamps.count >= 2 ? now.timeIntervalSince(updateTimestamps.first!) : 0
        let hz = span > 0.001 ? Double(updateTimestamps.count - 1) / span : 0
        DispatchQueue.main.async {
            self.updateHz = hz
            self.totalUpdates += 1
        }
    }

    private func log(_ s: String) { print("[\(deviceRole)] \(s)") }
}

// MARK: - NISessionDelegate
extension NIRangingManager: NISessionDelegate {
    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard let obj = nearbyObjects.first else { return }
        recordUpdate()
        DispatchQueue.main.async { self.distance = obj.distance }  // 워치/U2는 direction=nil, distance는 나옴
    }

    func session(_ session: NISession,
                 didRemove nearbyObjects: [NINearbyObject],
                 reason: NINearbyObject.RemovalReason) {
        DispatchQueue.main.async {
            self.distance = nil
            self.status = "피어 제거(reason=\(reason.rawValue)) — 사거리 이탈/타임아웃?"
        }
        // 타임아웃이면 마지막 config로 재시도(스파이크에서 드롭아웃 후 자동 회복 확인용)
        if reason == .timeout, let config = lastConfig {
            session.run(config)
        }
    }

    func sessionWasSuspended(_ session: NISession) {
        DispatchQueue.main.async { self.status = "세션 일시중단(백그라운드/워치 슬립?)" }
    }

    func sessionSuspensionEnded(_ session: NISession) {
        DispatchQueue.main.async { self.status = "세션 재개" }
        if let config = lastConfig { session.run(config) }  // 재개 시 반드시 재실행
    }

    func session(_ session: NISession, didInvalidateWith error: Error) {
        DispatchQueue.main.async { self.status = "세션 무효화: \(error.localizedDescription)" }
    }
}

// MARK: - WCSessionDelegate (토큰 교환 채널)
extension NIRangingManager: WCSessionDelegate {
    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        DispatchQueue.main.async {
            self.log("WC 활성화 상태=\(activationState.rawValue) err=\(String(describing: error))")
            self.shareTokenIfPossible()
        }
    }

    // 실시간 전달(sendMessageData)
    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        didReceiveTokenData(messageData)
    }

    // 큐잉 폴백(transferUserInfo)
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let data = userInfo["niToken"] as? Data { didReceiveTokenData(data) }
    }

    // 신뢰도 높은 상태 채널(updateApplicationContext)
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if let data = applicationContext["niToken"] as? Data { didReceiveTokenData(data) }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        shareTokenIfPossible()  // 상대 앱이 켜져 reachable 되는 순간 토큰 재전송
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    #endif
}
