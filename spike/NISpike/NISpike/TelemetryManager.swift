import Foundation
import WatchConnectivity
import Combine
#if os(watchOS)
import CoreMotion
#endif

/// E1(워치 가속도 수집) + E2(워치→메인폰 WCSession 전송)의 매니저.
///
/// - 워치: CoreMotion raw accelerometer를 50Hz로 샘플(낙상 충격 포착용 고주파) → TelemetryFrame 생성 →
///   콘솔 로그 + 화면 표시 + WCSession으로 폰에 10Hz로 전송(WC 실시간 메시지가 50Hz 연사에 안 맞아 스로틀).
/// - 폰: WCSession으로 프레임을 받아 콘솔 로그 + 화면 표시 + 수신 Hz 집계.
///
/// 제약: `WCSession.default`는 델리게이트가 하나뿐이라, 이 화면과 Phase 1 NI 화면을 **동시에 켜면 안 된다**.
/// RootView가 한 번에 한 화면만 띄우므로 실사용은 안전(화면 진입 시 WCSession 활성화).
final class TelemetryManager: NSObject, ObservableObject {

    // 공용 UI 상태
    @Published var running = false
    @Published var status = "대기"
    @Published var lastFrame: TelemetryFrame?
    @Published var hz: Double = 0          // 워치=전송 Hz, 폰=수신 Hz
    @Published var count = 0               // 폰=수신 프레임 수
    @Published var peakSMV: Double = 0     // 워치=세션 최대 SMV(드롭 스파이크 육안 확인용)

    private var wc: WCSession?
    private var stamps: [Date] = []        // Hz 계산용 최근 시각

    #if os(watchOS)
    let platform = "WATCH"
    private let motion = CMMotionManager()
    private let sampleHz = 50.0            // 샘플: 낙상 충격은 빠른 과도라 고주파 필요
    private let sendHz = 10.0              // 전송: WCSession 부하 회피
    private var seq = 0
    private var lastSent = Date.distantPast
    private var peakRaw = 0.0              // 매 샘플 갱신(비발행), 전송 틱마다 peakSMV로 발행
    #else
    let platform = "PHONE"
    #endif

    // MARK: 시작/정지
    func start() {
        guard !running else { return }
        #if os(watchOS)
        startSampling()
        #else
        setupWC()
        running = true
        setStatus("수신 대기 · 폰 앱을 포그라운드로 유지")
        #endif
    }

    func stop() {
        #if os(watchOS)
        motion.stopAccelerometerUpdates()
        #endif
        running = false
        setStatus("정지")
    }

    // MARK: WCSession
    private func setupWC() {
        guard WCSession.isSupported() else { setStatus("WCSession 미지원"); return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
        wc = s
    }

    // MARK: 워치 — 샘플링 + 전송
    #if os(watchOS)
    private func startSampling() {
        setupWC()
        guard motion.isAccelerometerAvailable else { setStatus("가속도계 없음"); return }
        motion.accelerometerUpdateInterval = 1.0 / sampleHz
        seq = 0
        peakRaw = 0
        peakSMV = 0
        lastSent = .distantPast
        running = true
        setStatus("샘플 \(Int(sampleHz))Hz · 전송 \(Int(sendHz))Hz · 손목 들어 화면 유지")
        motion.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
            guard let self = self, let a = data?.acceleration else { return }
            self.onSample(ax: a.x, ay: a.y, az: a.z)
        }
    }

    /// CoreMotion 콜백(.main 큐). 매 샘플 peak만 갱신하고, 전송 틱(10Hz)에만 프레임 생성·표시·전송·로그.
    private func onSample(ax: Double, ay: Double, az: Double) {
        let now = Date()
        let smv = TelemetryFrame.smv(ax: ax, ay: ay, az: az)
        if smv > peakRaw { peakRaw = smv }
        guard now.timeIntervalSince(lastSent) >= 1.0 / sendHz else { return }
        lastSent = now
        let frame = TelemetryFrame(seq: seq, ts: now.timeIntervalSince1970 * 1000,
                                   ax: ax, ay: ay, az: az)
        seq += 1
        lastFrame = frame
        peakSMV = peakRaw
        recordHz(now)
        print("[WATCH/TX] seq=\(frame.seq) a=(\(fmt(ax)),\(fmt(ay)),\(fmt(az))) smv=\(fmt(frame.smv))g")
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
            // 라이브 텔레메트리라 묵은 가속도를 큐잉하지 않고 드롭. (폰 포그라운드면 reachable)
            setStatus("폰 미도달 — 드롭(폰 앱 포그라운드 필요)")
        }
    }
    #endif

    // MARK: 수신(폰) 공통 처리
    private func handleReceived(_ data: Data) {
        guard let frame = try? JSONDecoder().decode(TelemetryFrame.self, from: data) else { return }
        DispatchQueue.main.async {
            self.lastFrame = frame
            self.count += 1
            self.recordHz(Date())
            print("[PHONE/RX] seq=\(frame.seq) a=(\(self.fmt(frame.ax)),\(self.fmt(frame.ay)),\(self.fmt(frame.az))) smv=\(self.fmt(frame.smv))g rx#\(self.count)")
        }
    }

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

// MARK: - WCSessionDelegate (워치=전송 활성 확인 · 폰=수신 입구)
extension TelemetryManager: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        setStatus(activationState == .activated ? "WC 활성" : "WC 활성 실패")
    }
    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        handleReceived(messageData)   // 백그라운드 큐 → handleReceived가 main으로 디스패치
    }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let data = userInfo["tf"] as? Data { handleReceived(data) }
    }
    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    #endif
}
