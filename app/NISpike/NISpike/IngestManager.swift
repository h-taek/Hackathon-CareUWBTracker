import Foundation
import NearbyInteraction
import WatchConnectivity
import Combine
#if os(watchOS)
import CoreMotion
import HealthKit
#endif
#if os(iOS)
import Network   // 폰↔폰 토큰 교환용. watchOS는 로컬 네트워크 금지라 이 채널을 안 쓴다.
#endif

/// 최종 측위·텔레메트리 매니저. 앵커 폰이 **1대든 2대든** 동작한다.
///
/// 역할 분담(얇은 폰):
/// - **워치 = 태그(전 측정).** 앵커마다 NI 세션을 하나씩(최대 2개: phoneMain·phoneSub) 열어 거리를 재고,
///   CoreMotion으로 가속도를 50Hz 샘플한다. 50Hz 샘플을 버퍼에 모아 10Hz로 배치(≈5개)로 묶어
///   `TelemetryBatch{samples:[accel(g)…], ranges:{phoneMain:r, phoneSub:r}}` 한 메시지로 메인폰에 전송
///   (전송 병목이 '메시지 횟수'였어서 횟수를 10회/초로 낮추되 50Hz 전 샘플은 보존).
/// - **메인폰 = 게이트웨이 + 중계.** 워치와 거리 측정, 서브폰 토큰을 워치↔서브폰 사이에서 중계,
///   프레임을 받아 g→m/s² 변환 + ingest 스키마(spec 03 §5)로 포장해 서버에 POST만 한다(연산 0).
/// - **서브폰 = 앵커2.** 워치와 거리 측정만. 서버 전송·중계 없음. (2대일 때만 사용)
///
/// 왜 이렇게 나눴나(다중세션·중계의 핵심):
/// - NI는 "상대 1명당 NISession 1개"다. 앵커 2대와 재려면 세션 2개 → `links[peerID]`로 피어별 세션을 든다.
/// - 각 세션은 자기 discoveryToken을 만든다. "이 토큰은 누구(from)→누구(to)"인지 주소를 붙여야 상대가
///   올바른 세션에 꽂는다 → `AddressedToken{from,to,token}`.
/// - 워치는 companion 폰(WCSession)하고만 통신 가능하다. 그래서 서브폰 토큰은 **메인폰이 중계**한다
///   (워치→WC→메인폰→네트워크→서브폰, 반대도 동일). `relays=true`인 메인폰이 그 다리다.
/// - UWB 거리 측정 자체는 토큰만 교환되면 두 라디오가 직접 잰다. 네트워크는 "전화번호(토큰) 교환"에만 쓴다.
///
/// WCSession 한 채널에 두 종류를 흘린다(멀티플렉싱):
/// - **NI 토큰**: raw 데이터(sendMessageData) 또는 userInfo["m"]. 주소가 붙어 있어 필요 시 메인폰이 중계.
/// - **텔레메트리 배치**: 키 메시지(sendMessage["batch"]). 워치→메인폰 단방향. + 제어(ctrl:stop) 양방향.
///
/// 최신화(캐시·묵은 데이터 방지):
/// - 시작할 때마다 세션·네트워크 채널을 새로 만든다(새 discoveryToken) → 묵은 토큰 latch 방지.
/// - 정지하면 모든 세션·연결·타이머·상태를 완전히 비운다(teardown).
/// - 워치독 타이머가 일정 시간 갱신 없는 앵커 거리를 nil로 만든다 → 얼어붙은 옛 거리가 남지 않는다.
final class IngestManager: NSObject, ObservableObject {

    // MARK: 식별자/상수
    static let tagID = "tag-watch"
    static let mainID = "phoneMain"
    static let subID = "phoneSub"
    static let gravity = 9.80665            // g -> m/s²
    private static let staleAfter = 1.5     // 이 시간(s) 넘게 갱신 없는 거리는 무효(nil)로

    /// 폰이 맡을 역할(화면에서 선택). 워치는 항상 태그라 이 값을 안 쓴다.
    enum PhoneRole: String, CaseIterable, Identifiable {
        case main = "메인폰(게이트웨이)"
        case sub  = "서브폰(앵커2)"
        var id: String { rawValue }
    }

    // MARK: 공용 UI 상태
    @Published var rangingRunning = false     // 워치/NI 링크 가동 여부
    @Published var status = "대기"
    @Published var peers: [PeerState] = []     // 앵커별 거리/Hz/연결
    @Published var lastFrame: TelemetryFrame?
    @Published var hz: Double = 0             // 워치=전송 Hz, 폰=수신 Hz

    // 폰 전용
    @Published var phoneRole: PhoneRole = .main
    @Published var serverPosting = false      // 서버 전송(POST) 링크 가동 여부 — 워치 링크와 독립
    @Published var postCount = 0
    @Published var lastPostStatus = ""
    /// 서버 주소. 맥의 Bonjour 이름(<맥이름>.local):포트 또는 사설 IP. DHCP로 IP가 바뀌어도 이름은 유지.
    @Published var serverHost = "MacBook-Pro-39.local:8080"

    var anyPeerConnected: Bool { peers.contains { $0.connected } }

    // MARK: 내부 상태
    private var role: Role?
    private var links: [String: PeerLink] = [:]
    private var sessionOwner: [ObjectIdentifier: String] = [:]   // NISession -> peerID 역인덱스
    private var wc: WCSession?
    private var retryTimer: Timer?
    private var watchdog: Timer?
    // 거리값은 NI 델리게이트(메인 큐)가 쓰고, 워치의 가속도 전용 큐가 프레임에 실으려 읽는다.
    // 두 쓰레드가 같은 메모리를 만지므로 락으로 보호되는 스냅샷 하나로만 주고받는다(links는 메인 큐 전용 유지).
    private let rangeLock = NSLock()
    private var sendRanges: [String: Double] = [:]
    #if os(iOS)
    private var net: NetworkTokenChannel?
    #endif

    #if os(watchOS)
    let platform = "WATCH"
    private let motion = CMMotionManager()
    private let sampleHz = 50.0
    // 전송 병목은 데이터 '양'이 아니라 '메시지 횟수'였다(실측: 수집 50Hz 정상인데 단건 50회/초로 쏘면 도착 30~50Hz 요동).
    // → 50Hz 전 샘플을 버퍼에 모아 10Hz(≈5개/배치)로 묶어 한 메시지로 보낸다. 전송 횟수는 검증된 10회/초로 되돌리되
    //   시간해상도(낙상 충격 피크)는 그대로 보존한다. 대가는 최대 ~100ms 버퍼 지연뿐(낙상 감지엔 무해).
    private let batchHz = 10.0
    private var seq = 0
    private var lastFlush = Date.distantPast
    private var batch: [TelemetryFrame] = []   // 전송 대기 샘플 버퍼(accelQueue 직렬 접근이라 락 불필요)
    private var inStamps: [Date] = []        // 가속도 센서 '수집' Hz 계산용 — 스로틀 전 모든 콜백을 센다
    // 가속도 수집·전송 전용 큐. NI(UWB)·타이머가 점유하는 메인 큐와 분리해 50Hz 샘플이 밀리지 않게 한다.
    // 직렬(maxConcurrent=1)이라 seq/lastFlush/batch/inStamps는 이 큐에서만 순차 접근된다(락 불필요).
    private let accelQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        q.name = "accel.sampling"
        return q
    }()
    private var lastHzPublish = Date.distantPast     // 수집 Hz 화면 반영 스로틀(계산은 매 샘플, 갱신만 ~10Hz)
    private var lastFramePublish = Date.distantPast  // 최신 프레임(3축/SMV) 화면 반영 스로틀
    // 손목을 내려 화면이 꺼지면 앱이 백그라운드로 가 측정·전송이 멈춘다. 운동 세션으로 백그라운드 실행을 유지한다.
    private let healthStore = HKHealthStore()
    private var workoutSession: HKWorkoutSession?
    #else
    let platform = "PHONE"
    private var recvStamps: [Date] = []      // 수신 Hz 계산용
    private var lastFrameAt: Date?           // 마지막 프레임 수신 시각(프레임 끊김 감지)
    private lazy var urlSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral   // 캐시/쿠키 없는 세션 — 묵은 응답 재사용 방지
        cfg.timeoutIntervalForRequest = 2             // 라이브 스트림이라 오래 안 기다림
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()
    #endif

    // MARK: - 워치/NI 링크 시작·정지 (서버 전송과 독립)
    func startRanging() {
        guard !rangingRunning else { return }
        guard NISession.isSupported else { setStatus("이 기기는 NI 미지원(U1/U2 없음)"); return }
        let role = makeRole()
        self.role = role
        rangingRunning = true

        // 피어별 세션 생성(매번 새로 → 새 토큰, 묵은 토큰 latch 방지).
        for spec in role.peers {
            let s = NISession()
            s.delegate = self
            links[spec.id] = PeerLink(spec: spec, session: s)
            sessionOwner[ObjectIdentifier(s)] = spec.id
        }
        // 표시 목록: 워치·서브폰은 자기 NI 링크(측정 상대)를, 메인폰은 프레임이 실어오는 앵커(phoneMain/phoneSub)를 보여준다.
        #if os(iOS)
        if role.myID == IngestManager.mainID {
            peers = [PeerState(id: IngestManager.mainID, chan: "frame", distance: nil, hz: 0, connected: false),
                     PeerState(id: IngestManager.subID,  chan: "frame", distance: nil, hz: 0, connected: false)]
        } else {
            peers = role.peers.map {
                PeerState(id: $0.id, chan: $0.chan == .wc ? "WC" : "NET", distance: nil, hz: 0, connected: false)
            }
        }
        #else
        peers = role.peers.map {
            PeerState(id: $0.id, chan: $0.chan == .wc ? "WC" : "NET", distance: nil, hz: 0, connected: false)
        }
        #endif

        if role.usesWC { setupWC() }
        #if os(iOS)
        if role.usesNet { setupNet() }
        #endif
        #if os(watchOS)
        startSampling()
        #endif

        // 붙을 때까지 내 토큰들을 반복 전송(타이밍/묵은토큰 극복). 모든 피어가 실제 거리 갱신되면 멈춤.
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] t in
            guard let self = self, self.rangingRunning else { t.invalidate(); return }
            self.shareMyTokens()
            if !self.links.isEmpty, self.links.values.allSatisfy({ $0.connected }) { t.invalidate() }
        }
        // 워치독: 갱신 끊긴 거리를 주기적으로 무효화(얼어붙은 옛 거리 방지).
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.expireStaleDistances()
        }
        setStatus("\(role.myID) 시작 · 피어 [\(role.peers.map { $0.id }.joined(separator: ", "))]")
    }

    /// signalPeer=true면 상대(워치↔폰)에게도 정지를 알린다 → 상대가 백그라운드로 계속 측정·전송하지 않게.
    /// (버튼에서 부른 사용자 정지만 true. ctrl:stop 수신으로 부른 정지는 false여서 되돌려 보내지 않음 → 루프 방지)
    func stopRanging(signalPeer: Bool = false) {
        if signalPeer { signalPeerStop() }
        rangingRunning = false
        retryTimer?.invalidate(); retryTimer = nil
        watchdog?.invalidate(); watchdog = nil
        // 모든 세션 무효화 + 역인덱스/링크 비우기(묵은 상태 제거).
        for link in links.values { link.session.invalidate() }
        links.removeAll()
        sessionOwner.removeAll()
        rangeLock.lock(); sendRanges.removeAll(); rangeLock.unlock()
        #if os(iOS)
        net?.stop(); net = nil
        lastFrameAt = nil
        #endif
        #if os(watchOS)
        motion.stopAccelerometerUpdates()
        endWorkout()
        #endif
        role = nil
        peers = []
        lastFrame = nil
        hz = 0
        setStatus("정지")
    }

    #if os(watchOS)
    private func makeRole() -> Role {
        Role(myID: IngestManager.tagID,
             peers: [PeerSpec(id: IngestManager.mainID, chan: .wc),
                     PeerSpec(id: IngestManager.subID, chan: .wc)],
             relays: false)
    }
    #else
    private func makeRole() -> Role {
        switch phoneRole {
        case .main:  // 게이트웨이 + 중계: 워치와 거리(WC), 서브폰 토큰 중계(net)
            return Role(myID: IngestManager.mainID,
                        peers: [PeerSpec(id: IngestManager.tagID, chan: .wc)], relays: true)
        case .sub:   // 앵커2: 워치와 거리(net으로 토큰, 메인폰이 중계)
            return Role(myID: IngestManager.subID,
                        peers: [PeerSpec(id: IngestManager.tagID, chan: .net)], relays: false)
        }
    }
    #endif

    // MARK: - 서버 전송 링크 시작·정지 (워치 링크와 독립, 메인폰 전용)
    #if os(iOS)
    func startPosting() {
        guard phoneRole == .main else { setStatus("서브폰은 서버 전송을 하지 않습니다"); return }
        postCount = 0
        lastPostStatus = ""
        serverPosting = true
        setStatus("서버 전송 시작 · \(serverHost)")
    }
    func stopPosting() {
        serverPosting = false
        setStatus("서버 전송 정지")
    }
    #endif

    // MARK: WCSession
    private func setupWC() {
        guard WCSession.isSupported() else { setStatus("WCSession 미지원"); return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
        wc = s
    }

    #if os(iOS)
    private func setupNet() {
        let ch = NetworkTokenChannel(
            onMessage:   { [weak self] data in self?.handleIncoming(data, via: .net) },
            onConnected: { [weak self] in self?.shareMyTokens() },
            log:         { _ in })
        ch.start()
        net = ch
    }
    #endif

    // MARK: 토큰 공유 (피어별로 다름)
    private func shareMyTokens() {
        guard let role = role else { return }
        for spec in role.peers {
            guard let link = links[spec.id], let tok = link.session.discoveryToken,
                  let tokData = try? NSKeyedArchiver.archivedData(withRootObject: tok,
                                                                  requiringSecureCoding: true) else { continue }
            let msg = AddressedToken(from: role.myID, to: spec.id, token: tokData)
            guard let data = try? JSONEncoder().encode(msg) else { continue }
            send(data, on: spec.chan)
        }
    }

    private func send(_ data: Data, on chan: Chan) {
        switch chan {
        case .wc:
            guard let wc = wc, wc.activationState == .activated else { return }
            if wc.isReachable {
                wc.sendMessageData(data, replyHandler: nil) { _ in wc.transferUserInfo(["m": data]) }
            } else {
                wc.transferUserInfo(["m": data])   // 상대 앱 꺼져있으면 큐잉
            }
        case .net:
            #if os(iOS)
            net?.broadcast(data)
            #endif
        }
    }

    // MARK: 제어 신호(정지 전파) — 한쪽에서 멈추면 상대도 멈춰 백그라운드 유령 전송을 막는다.
    /// 상대에게 "정지" 알림. 상대 앱이 백그라운드/미도달이어도 transferUserInfo로 큐잉해 다음 활성 때 전달한다.
    private func signalPeerStop() {
        guard let wc = wc, wc.activationState == .activated else { return }
        if wc.isReachable {
            wc.sendMessage(["ctrl": "stop"], replyHandler: nil) { [weak self] _ in
                self?.wc?.transferUserInfo(["ctrl": "stop"])
            }
        } else {
            wc.transferUserInfo(["ctrl": "stop"])
        }
    }

    /// 상대가 보낸 제어 신호 처리. stop이면 이쪽도 정지(되돌려 보내지 않아 루프 없음).
    private func handleControl(_ cmd: String) {
        guard cmd == "stop" else { return }
        DispatchQueue.main.async {
            guard self.rangingRunning else { return }
            self.stopRanging()   // signalPeer 기본 false
        }
    }

    // MARK: 토큰 수신 + (메인폰이면) 중계
    private func handleIncoming(_ data: Data, via: Chan) {
        guard rangingRunning,
              let msg = try? JSONDecoder().decode(AddressedToken.self, from: data) else { return }
        if msg.to == role?.myID {
            deliver(msg)
        } else if role?.relays == true {
            let out: Chan = (via == .wc) ? .net : .wc   // 온 채널의 반대쪽으로 넘김
            send(data, on: out)
        }
    }

    private func deliver(_ msg: AddressedToken) {
        guard let link = links[msg.from] else { return }       // 내 피어가 아니면 무시
        guard link.runningToken != msg.token else { return }   // 같은 토큰이면 스킵(묵은 토큰 방지)
        guard let tok = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self,
                                                                from: msg.token) else { return }
        link.runningToken = msg.token
        let config = NINearbyPeerConfiguration(peerToken: tok)
        link.lastConfig = config
        link.session.run(config)
        setPeer(msg.from) { $0.connected = true }
    }

    // MARK: 거리 갱신/워치독
    /// 메인 큐에서 link.distance를 바꿀 때마다 가속도 큐가 읽는 스냅샷도 락 걸고 함께 갱신한다.
    private func updateSendRange(_ id: String, _ distance: Double?) {
        rangeLock.lock()
        if let d = distance { sendRanges[id] = d } else { sendRanges.removeValue(forKey: id) }
        rangeLock.unlock()
    }

    private func recordUpdate(_ id: String, distance: Double?) {
        guard let link = links[id] else { return }
        let now = Date()
        link.distance = distance
        updateSendRange(id, distance)
        link.lastUpdate = now
        link.stamps.append(now)
        link.stamps.removeAll { now.timeIntervalSince($0) > 2.0 }
        let span = link.stamps.count >= 2 ? now.timeIntervalSince(link.stamps.first!) : 0
        let hz = span > 0.001 ? Double(link.stamps.count - 1) / span : 0
        setPeer(id) { $0.distance = distance; $0.hz = hz }
    }

    /// 갱신이 끊긴 거리를 무효화 → 얼어붙은 옛 거리가 프레임/화면에 남지 않는다.
    private func expireStaleDistances() {
        let now = Date()
        for (id, link) in links {
            guard link.distance != nil else { continue }
            if let last = link.lastUpdate, now.timeIntervalSince(last) > IngestManager.staleAfter {
                link.distance = nil
                updateSendRange(id, nil)
                setPeer(id) { $0.distance = nil; $0.hz = 0 }
            }
        }
        #if os(iOS)
        // 메인폰: 프레임(워치→폰)이 끊기면 표시 거리·가속도를 비운다(워치만 정지해도 화면이 최신화됨).
        if role?.myID == IngestManager.mainID, let last = lastFrameAt,
           now.timeIntervalSince(last) > IngestManager.staleAfter {
            lastFrame = nil
            for p in peers { setPeer(p.id) { $0.distance = nil; $0.hz = 0; $0.connected = false } }
        }
        #endif
    }

    private func setPeer(_ id: String, _ mut: @escaping (inout PeerState) -> Void) {
        DispatchQueue.main.async {
            guard let i = self.peers.firstIndex(where: { $0.id == id }) else { return }
            var s = self.peers[i]; mut(&s); self.peers[i] = s
        }
    }

    // MARK: - 워치: accel 샘플 + 프레임 송신
    #if os(watchOS)
    private func startSampling() {
        guard motion.isAccelerometerAvailable else { setStatus("가속도계 없음"); return }
        motion.accelerometerUpdateInterval = 1.0 / sampleHz
        seq = 0
        lastFlush = .distantPast
        lastHzPublish = .distantPast
        lastFramePublish = .distantPast
        inStamps.removeAll()
        batch.removeAll()
        startWorkoutKeepAlive()
        // 전용 큐로 콜백을 받는다 → NI 델리게이트(메인 큐)가 아무리 바빠도 가속도 샘플링이 밀리지 않는다.
        motion.startAccelerometerUpdates(to: accelQueue) { [weak self] data, _ in
            guard let self = self, let a = data?.acceleration else { return }
            self.onSample(ax: a.x, ay: a.y, az: a.z)
        }
    }

    /// 매 샘플(50Hz)을 버퍼에 쌓고, batchHz(10Hz) 주기마다 묶어서 한 메시지로 flush.
    /// accelQueue(직렬)에서만 호출 → seq/batch/lastFlush는 락 없이 순차 접근된다.
    private func onSample(ax: Double, ay: Double, az: Double) {
        guard rangingRunning else { return }
        let now = Date()
        recordIntakeHz(now)   // 화면 표시용: 가속도 센서가 실제로 주는 수집 Hz(배치와 무관)
        // 전 샘플을 버퍼에 적재. 거리는 샘플엔 안 담는다 — flush 때 배치당 최신 스냅샷 1개로 붙인다.
        batch.append(TelemetryFrame(seq: seq, ts: now.timeIntervalSince1970 * 1000,
                                    ax: ax, ay: ay, az: az))
        seq += 1
        guard now.timeIntervalSince(lastFlush) >= 1.0 / batchHz else { return }
        lastFlush = now
        flushBatch(now)
    }

    /// 버퍼를 비우며 최신 거리 스냅샷과 함께 한 메시지로 전송.
    private func flushBatch(_ now: Date) {
        guard !batch.isEmpty else { return }
        // 거리 스냅샷을 락 걸고 복사한다. links 딕셔너리는 메인 큐 전용이라 여기서 직접 만지지 않는다.
        rangeLock.lock()
        let ranges = sendRanges
        rangeLock.unlock()
        let payload = TelemetryBatch(samples: batch, ranges: ranges.isEmpty ? nil : ranges)
        let last = batch[batch.count - 1]
        batch.removeAll(keepingCapacity: true)
        sendBatch(payload)
        publishFrame(now, last)   // 워치 화면엔 배치의 마지막 샘플만 반영(≈10Hz)
    }

    private func sendBatch(_ payload: TelemetryBatch) {
        guard let wc = wc, wc.activationState == .activated,
              let data = try? JSONEncoder().encode(payload) else { return }
        if wc.isReachable {
            wc.sendMessage(["batch": data], replyHandler: nil, errorHandler: { [weak self] e in
                self?.setStatus("전송 오류: \(e.localizedDescription)")
            })
        } else {
            setStatus("폰 미도달 — 드롭(폰 앱 포그라운드 필요)")
        }
    }

    /// 가속도 센서 수집 Hz(스로틀 전 전체 콜백)를 계산해 워치 화면 `hz`에 반영한다.
    /// 계산은 매 샘플, @Published 반영만 ~10Hz로 스로틀(메인 큐를 다시 채우지 않게).
    /// (@Published를 백그라운드 큐에서 직접 쓰면 SwiftUI가 경고하므로 반드시 메인으로 마샬)
    private func recordIntakeHz(_ now: Date) {
        inStamps.append(now)
        inStamps.removeAll { now.timeIntervalSince($0) > 2.0 }
        let span = inStamps.count >= 2 ? now.timeIntervalSince(inStamps.first!) : 0
        let h = span > 0.001 ? Double(inStamps.count - 1) / span : 0
        guard now.timeIntervalSince(lastHzPublish) >= 0.1 else { return }
        lastHzPublish = now
        DispatchQueue.main.async { self.hz = h }
    }

    /// 최신 프레임(3축/SMV 표시용)을 ~10Hz로 스로틀해 메인으로 반영.
    private func publishFrame(_ now: Date, _ frame: TelemetryFrame) {
        guard now.timeIntervalSince(lastFramePublish) >= 0.1 else { return }
        lastFramePublish = now
        DispatchQueue.main.async { self.lastFrame = frame }
    }

    // MARK: 운동 세션(손목 내려도 앱 유지) — 건강 데이터는 저장 안 하고 백그라운드 실행만 얻는다.
    private func startWorkoutKeepAlive() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let share: Set = [HKObjectType.workoutType()]
        healthStore.requestAuthorization(toShare: share, read: []) { [weak self] _, _ in
            DispatchQueue.main.async { self?.beginWorkoutSession() }
        }
    }

    private func beginWorkoutSession() {
        guard workoutSession == nil else { return }
        let config = HKWorkoutConfiguration()
        config.activityType = .other
        config.locationType = .indoor
        do {
            let session = try HKWorkoutSession(healthStore: healthStore, configuration: config)
            session.startActivity(with: Date())
            workoutSession = session
        } catch {
            setStatus("운동 세션 실패: \(error.localizedDescription)")
        }
    }

    private func endWorkout() {
        workoutSession?.end()
        workoutSession = nil
    }
    #endif

    // MARK: - 메인폰: 프레임 수신 -> ingest POST
    #if os(iOS)
    private func onBatch(_ data: Data) {
        guard rangingRunning,
              let payload = try? JSONDecoder().decode(TelemetryBatch.self, from: data) else { return }
        DispatchQueue.main.async {
            let now = Date()
            self.lastFrameAt = now
            // 배치 안 샘플을 순서대로 펼쳐 각각 처리(각 샘플에 배치 거리 스냅샷을 붙인다).
            for s in payload.samples {
                let frame = TelemetryFrame(seq: s.seq, ts: s.ts,
                                           ax: s.ax, ay: s.ay, az: s.az, ranges: payload.ranges)
                self.lastFrame = frame
                self.recordRecvHz(now)   // 샘플 단위로 세어 '실제 데이터 도착 Hz'(≈50)를 표시
                if self.serverPosting { self.postIngest(frame) }
            }
            // 화면: 배치가 담아온 앵커 거리(phoneMain/phoneSub)만 배치당 1회 반영(샘플마다 반복 불필요).
            for p in self.peers {
                let d = payload.ranges?[p.id]
                self.setPeer(p.id) { $0.distance = d; $0.connected = (d != nil); $0.hz = d != nil ? self.hz : 0 }
            }
        }
    }

    private func recordRecvHz(_ now: Date) {
        recvStamps.append(now)
        recvStamps.removeAll { now.timeIntervalSince($0) > 2.0 }
        let span = recvStamps.count >= 2 ? now.timeIntervalSince(recvStamps.first!) : 0
        hz = span > 0.001 ? Double(recvStamps.count - 1) / span : 0
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
        req.cachePolicy = .reloadIgnoringLocalCacheData
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

    private func setStatus(_ s: String) { DispatchQueue.main.async { self.status = s } }
}

// MARK: - 토큰/역할 모델 (라우팅에 쓰는 값 타입)

/// 주소가 붙은 토큰 메시지(JSON으로 직렬화해 WC/네트워크 어디로든 보냄).
struct AddressedToken: Codable {
    let from: String    // 보낸 기기 역할 ID
    let to: String      // 받을 기기 역할 ID
    let token: Data     // NSKeyedArchiver로 아카이브한 NIDiscoveryToken
}

enum Chan { case wc, net }   // 이 피어에게 내 토큰을 보낼 채널

struct PeerSpec { let id: String; let chan: Chan }

/// 이 기기가 맡을 역할.
struct Role {
    let myID: String
    let peers: [PeerSpec]      // 내가 거리 잴 상대들 (각자 세션 1개)
    let relays: Bool           // true면 나한테 안 온 메시지를 반대 채널로 중계(메인폰 전용)
    var usesWC: Bool { relays || peers.contains { $0.chan == .wc } }
    var usesNet: Bool { relays || peers.contains { $0.chan == .net } }
}

/// 피어별 링크(세션 + 상태).
final class PeerLink {
    let spec: PeerSpec
    let session: NISession
    var runningToken: Data?                       // 지금 돌고 있는 상대 토큰(묵은 토큰 추적)
    var lastConfig: NINearbyPeerConfiguration?    // 타임아웃 시 재실행용
    var connected = false                          // didUpdate를 받았는가(토큰 재전송 중단·연결 판단)
    var distance: Double?                          // 최신 측정 거리(m). 워치독이 무효화 가능
    var lastUpdate: Date?                          // 마지막 didUpdate 시각(워치독 판단용)
    var stamps: [Date] = []                        // Hz 계산용
    init(spec: PeerSpec, session: NISession) { self.spec = spec; self.session = session }
}

/// UI 노출용 앵커 상태.
struct PeerState: Identifiable {
    let id: String
    var chan: String
    var distance: Double?
    var hz: Double
    var connected: Bool
}

// MARK: - NISessionDelegate (세션 -> 어떤 피어인지 sessionOwner로 역추적)
extension IngestManager: NISessionDelegate {
    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard rangingRunning,
              let id = sessionOwner[ObjectIdentifier(session)],
              let obj = nearbyObjects.first else { return }
        links[id]?.connected = true
        setPeer(id) { $0.connected = true }   // 표시 행이 있으면(워치·서브폰) 켜고, 메인폰의 tag-watch는 행이 없어 무시된다.
        recordUpdate(id, distance: obj.distance.map { Double($0) })
    }

    func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject],
                 reason: NINearbyObject.RemovalReason) {
        guard let id = sessionOwner[ObjectIdentifier(session)] else { return }
        if let link = links[id] { link.distance = nil; link.connected = false }
        updateSendRange(id, nil)
        setPeer(id) { $0.distance = nil; $0.hz = 0; $0.connected = false }   // 사거리 이탈: 거리 없음
        if reason == .timeout, let cfg = links[id]?.lastConfig { session.run(cfg) }  // 자동 회복
    }

    func sessionWasSuspended(_ session: NISession) {}
    func sessionSuspensionEnded(_ session: NISession) {
        guard let id = sessionOwner[ObjectIdentifier(session)] else { return }
        if let cfg = links[id]?.lastConfig { session.run(cfg) }   // 재개 시 반드시 재실행
    }
    func session(_ session: NISession, didInvalidateWith error: Error) {
        setStatus("세션 무효화: \(error.localizedDescription)")
    }
}

// MARK: - WCSessionDelegate (토큰=raw/키'm' 채널 / 프레임=키'frame' 채널)
extension IngestManager: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        DispatchQueue.main.async { self.shareMyTokens() }
    }

    // raw 데이터 == NI 토큰(AddressedToken)
    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        handleIncoming(messageData, via: .wc)
    }

    // 키 메시지: "ctrl"=제어(정지 전파), "batch"=텔레메트리 배치(폰만 수신), "m"=큐잉된 토큰
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let cmd = message["ctrl"] as? String { handleControl(cmd); return }
        #if os(iOS)
        if let d = message["batch"] as? Data { onBatch(d); return }
        #endif
        if let d = message["m"] as? Data { handleIncoming(d, via: .wc) }
    }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let cmd = userInfo["ctrl"] as? String { handleControl(cmd); return }
        if let data = userInfo["m"] as? Data { handleIncoming(data, via: .wc) }
    }
    func sessionReachabilityDidChange(_ session: WCSession) {
        if !anyPeerConnected { shareMyTokens() }
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    #endif
}
