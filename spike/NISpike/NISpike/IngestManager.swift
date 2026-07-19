import Foundation
import NearbyInteraction
import WatchConnectivity
import Combine
#if os(watchOS)
import CoreMotion
#endif

/// E3(메인폰 -> 서버 ingest 전송)의 매니저.
///
/// 역할 분담(얇은 폰):
/// - **워치 = 전 측정.** NI 세션(-> 메인폰)으로 거리(r_A)를 재고, CoreMotion으로 가속도를 50Hz 샘플한다.
///   둘을 한 프레임 `{accel(g), ranges:{phoneMain: r_A}}`으로 묶어 WCSession으로 메인폰에 10Hz 전송.
/// - **메인폰 = 순수 게이트웨이.** 프레임을 받아 g->m/s² 변환 + ingest 스키마(spec 03 §5)로 포장해
///   서버에 HTTP POST만 한다(연산 0). 서버가 삼각측량·낙상 판정을 한다.
///
/// WCSession 한 채널에 두 종류를 흘린다(멀티플렉싱):
/// - **NI 토큰**: 키 붙은 채널(sendMessage/userInfo/applicationContext, key `niToken`). 양방향.
/// - **텔레메트리 프레임**: raw 데이터 채널(sendMessageData). 워치->폰 단방향.
///   수신측은 "raw 데이터 == 프레임 / 키 있는 메시지 == 토큰"으로 구분한다.
///
/// 거리 대칭성 메모: NI는 양방향이라 폰도 자기 세션에서 같은 거리를 얻지만, spec §5 문구(워치가 잰 값)와
/// 양산 MaUWB(태그가 측정) 구조에 맞춰 **거리의 진실 출처는 워치 프레임**으로 둔다. 폰 세션은 토큰 상대로만 존재.
///
/// 앵커 확장: 지금은 메인폰 1개(anchorId="phoneMain"). 서브폰이 붙으면 워치가 세션 하나를 더 열어
/// ranges["phoneSub"]를 채우고(토큰은 폰이 중계, Phase 1 B 로직), 폰은 그대로 배열로 내보낸다. 스키마 불변.
final class IngestManager: NSObject, ObservableObject {

    // MARK: 공용 UI 상태
    @Published var running = false
    @Published var status = "대기"
    @Published var distance: Double?     // 현재 r_A(m). 워치=자기 측정, 폰=마지막 프레임값
    @Published var lastFrame: TelemetryFrame?
    @Published var peerConnected = false
    @Published var hz: Double = 0        // 워치=전송 Hz, 폰=수신 Hz

    // 폰 전용
    @Published var postCount = 0         // 성공 POST 수
    @Published var lastPostStatus = ""   // 마지막 POST 결과(HTTP 코드/에러)
    /// 서버 주소. 폰과 같은 Wi-Fi의 맥 LAN IP:포트. 화면에서 편집(기본값=현재 맥 LAN IP, 바뀌면 수정).
    @Published var serverHost = "192.168.25.6:8080"

    static let anchorMainID = "phoneMain"
    static let tagID = "tag-watch"
    static let gravity = 9.80665         // g -> m/s²

    private var wc: WCSession?
    private var niSession: NISession?
    private var lastConfig: NINearbyPeerConfiguration?
    private var runningPeerTokenData: Data?
    private var retryTimer: Timer?
    private var stamps: [Date] = []      // Hz 계산용

    #if os(watchOS)
    let platform = "WATCH"
    private let motion = CMMotionManager()
    private let sampleHz = 50.0
    private let sendHz = 10.0
    private var seq = 0
    private var lastSent = Date.distantPast
    #else
    let platform = "PHONE"
    private lazy var urlSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 2      // 라이브 스트림이라 오래 안 기다림
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()
    #endif

    // MARK: 시작/정지
    func start() {
        guard !running else { return }
        guard NISession.isSupported else { setStatus("이 기기는 NI 미지원(U1/U2 없음)"); return }
        setupNI()
        setupWC()
        running = true
        #if os(watchOS)
        startSampling()
        #else
        setStatus("수신 대기 · 폰 앱 포그라운드 유지 · 서버 \(serverHost)")
        #endif
        // 붙을 때까지 내 토큰 반복 전송(타이밍/묵은토큰 극복). 첫 거리 업데이트 오면 멈춤.
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] t in
            guard let self = self else { t.invalidate(); return }
            if self.peerConnected { t.invalidate(); return }
            self.shareToken()
        }
    }

    func stop() {
        #if os(watchOS)
        motion.stopAccelerometerUpdates()
        #endif
        retryTimer?.invalidate()
        niSession?.invalidate()
        running = false
        peerConnected = false
        setStatus("정지")
    }

    // MARK: NI 세션
    private func setupNI() {
        let s = NISession()
        s.delegate = self
        niSession = s
    }

    // MARK: WCSession
    private func setupWC() {
        guard WCSession.isSupported() else { setStatus("WCSession 미지원"); return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
        wc = s
    }

    // MARK: NI 토큰 공유 (키 채널만! raw 채널은 프레임 전용이라 여기서 안 씀)
    private func shareToken() {
        guard let token = niSession?.discoveryToken,
              let wc = wc, wc.activationState == .activated,
              let data = try? NSKeyedArchiver.archivedData(withRootObject: token,
                                                           requiringSecureCoding: true) else { return }
        if wc.isReachable {
            wc.sendMessage(["niToken": data], replyHandler: nil) { _ in
                wc.transferUserInfo(["niToken": data])
            }
        } else {
            wc.transferUserInfo(["niToken": data])   // 상대 앱 꺼져있으면 큐잉
        }
        try? wc.updateApplicationContext(["niToken": data])  // 신뢰도 높은 최신상태 채널
    }

    // MARK: 상대 토큰 수신 -> 레인징 시작
    private func onToken(_ data: Data) {
        guard data != runningPeerTokenData,
              let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self,
                                                                  from: data) else { return }
        runningPeerTokenData = data
        let config = NINearbyPeerConfiguration(peerToken: token)
        lastConfig = config
        niSession?.run(config)
        setStatus("레인징 시작")
    }

    // MARK: 워치 — accel 샘플 + 프레임 송신
    #if os(watchOS)
    private func startSampling() {
        guard motion.isAccelerometerAvailable else { setStatus("가속도계 없음"); return }
        motion.accelerometerUpdateInterval = 1.0 / sampleHz
        seq = 0
        lastSent = .distantPast
        setStatus("측정 시작 · 샘플 \(Int(sampleHz))Hz · 전송 \(Int(sendHz))Hz")
        motion.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
            guard let self = self, let a = data?.acceleration else { return }
            self.onSample(ax: a.x, ay: a.y, az: a.z)
        }
    }

    /// CoreMotion 콜백(.main). 전송 틱(10Hz)에만 프레임 생성·전송. 거리는 최신 NI 측정값을 실어 보낸다.
    private func onSample(ax: Double, ay: Double, az: Double) {
        let now = Date()
        guard now.timeIntervalSince(lastSent) >= 1.0 / sendHz else { return }
        lastSent = now
        var ranges: [String: Double]? = nil
        if let d = distance { ranges = [IngestManager.anchorMainID: d] }   // 세션 붙었을 때만 채움
        let frame = TelemetryFrame(seq: seq, ts: now.timeIntervalSince1970 * 1000,
                                   ax: ax, ay: ay, az: az, ranges: ranges)
        seq += 1
        lastFrame = frame
        recordHz(now)
        sendFrame(frame)
    }

    private func sendFrame(_ frame: TelemetryFrame) {
        guard let wc = wc, wc.activationState == .activated,
              let data = try? JSONEncoder().encode(frame) else { return }
        if wc.isReachable {
            wc.sendMessageData(data, replyHandler: nil, errorHandler: { [weak self] e in
                self?.setStatus("전송 오류: \(e.localizedDescription)")
            })
        } else {
            setStatus("폰 미도달 — 드롭(폰 앱 포그라운드 필요)")
        }
    }
    #endif

    // MARK: 폰 — 프레임 수신 -> ingest POST
    #if os(iOS)
    private func onFrame(_ data: Data) {
        guard let frame = try? JSONDecoder().decode(TelemetryFrame.self, from: data) else { return }
        DispatchQueue.main.async {
            self.lastFrame = frame
            self.distance = frame.ranges?[IngestManager.anchorMainID]
            self.recordHz(Date())
            self.postIngest(frame)
        }
    }

    /// 프레임 -> spec 03 §5 ingest JSON -> 서버 POST. 폰은 변환·포장만(연산 없음).
    private func postIngest(_ frame: TelemetryFrame) {
        guard let url = URL(string: "http://\(serverHost)/ingest") else {
            lastPostStatus = "URL 오류"; return
        }
        let g = IngestManager.gravity
        // ranges 맵 -> ingest 배열. 채워진 앵커만 내보낸다(빈 세션이면 빈 배열).
        let rangesArr: [[String: Any]] = (frame.ranges ?? [:]).map {
            ["anchorId": $0.key, "distance": $0.value]
        }
        let body: [String: Any] = [
            "tagId": IngestManager.tagID,
            "ts": frame.ts,
            "ranges": rangesArr,
            "accel": ["x": frame.ax * g, "y": frame.ay * g, "z": frame.az * g],  // g -> m/s²
            "source": "ni",
        ]
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else {
            lastPostStatus = "직렬화 오류"; return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = payload
        urlSession.dataTask(with: req) { [weak self] _, resp, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let err = err {
                    self.lastPostStatus = "POST 실패: \(err.localizedDescription)"
                } else if let http = resp as? HTTPURLResponse {
                    self.lastPostStatus = "HTTP \(http.statusCode)"
                    if (200..<300).contains(http.statusCode) { self.postCount += 1 }
                }
            }
        }.resume()
    }
    #endif

    // MARK: Hz 집계 (최근 2초 창)
    private func recordHz(_ now: Date) {
        stamps.append(now)
        stamps.removeAll { now.timeIntervalSince($0) > 2.0 }
        let span = stamps.count >= 2 ? now.timeIntervalSince(stamps.first!) : 0
        hz = span > 0.001 ? Double(stamps.count - 1) / span : 0
    }

    private func setStatus(_ s: String) { DispatchQueue.main.async { self.status = s } }
    private func fmt(_ v: Double) -> String { String(format: "%+.2f", v) }
}

// MARK: - NISessionDelegate (거리 측정)
extension IngestManager: NISessionDelegate {
    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard let obj = nearbyObjects.first else { return }
        DispatchQueue.main.async {
            if !self.peerConnected { self.peerConnected = true; self.retryTimer?.invalidate() }
            // 워치: 자기 세션 거리를 진실값으로 보관(프레임에 실림). 폰: 표시는 프레임값을 쓰므로 참고만.
            #if os(watchOS)
            if let d = obj.distance { self.distance = Double(d) }
            #endif
        }
    }

    func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject],
                 reason: NINearbyObject.RemovalReason) {
        DispatchQueue.main.async {
            #if os(watchOS)
            self.distance = nil   // 사거리 이탈: 거리 없음 -> 프레임 ranges 비움
            #endif
        }
        if reason == .timeout, let config = lastConfig { session.run(config) }  // 자동 회복
    }

    func sessionWasSuspended(_ session: NISession) {}
    func sessionSuspensionEnded(_ session: NISession) {
        if let config = lastConfig { session.run(config) }   // 재개 시 반드시 재실행
    }
    func session(_ session: NISession, didInvalidateWith error: Error) {
        setStatus("세션 무효화: \(error.localizedDescription)")
    }
}

// MARK: - WCSessionDelegate (토큰=키채널 / 프레임=raw채널)
extension IngestManager: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        DispatchQueue.main.async { self.shareToken() }
    }

    // raw 데이터 == 텔레메트리 프레임 (폰만 수신)
    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        #if os(iOS)
        onFrame(messageData)
        #endif
    }

    // 키 있는 메시지 == NI 토큰 (양쪽)
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let data = message["niToken"] as? Data { onToken(data) }
    }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let data = userInfo["niToken"] as? Data { onToken(data) }
    }
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if let data = applicationContext["niToken"] as? Data { onToken(data) }
    }
    func sessionReachabilityDidChange(_ session: WCSession) {
        if !peerConnected { shareToken() }
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    #endif
}
