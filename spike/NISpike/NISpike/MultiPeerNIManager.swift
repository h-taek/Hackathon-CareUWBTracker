import Foundation
import NearbyInteraction
import WatchConnectivity
import Combine
#if os(iOS)
import Network   // 폰↔폰 토큰 교환용. watchOS는 로컬 네트워크 금지라 이 채널을 안 쓴다.
#endif

/// Phase 1: 앵커 2대 + 태그 1대에서 **한 기기가 NI 세션 2개를 동시에** 유지할 수 있는지 검증하는 매니저.
///
/// 핵심 아이디어(왜 이렇게 나눴나):
/// - NI는 "상대 1명당 NISession 1개"다. 2개 앵커와 재려면 세션이 2개 필요하다 → `links[peerID]`로 피어별 세션을 든다.
/// - 각 세션은 자기만의 discoveryToken을 만든다. 그래서 "이 토큰은 누구(from)가 누구(to)에게" 인지 주소를 붙여야
///   상대가 올바른 세션에 꽂는다 → `AddressedToken{from,to,token}`.
/// - 워치는 companion 폰(WCSession)하고만 통신 가능하다. 그래서 2번째 앵커(폰2) 토큰은
///   **폰1이 중계**한다(워치→WC→폰1→네트워크→폰2, 반대도 동일). `relays=true`인 역할이 그 다리 역할.
/// - UWB 거리 측정 자체는 토큰만 교환되면 두 라디오가 직접 잰다. 네트워크는 "전화번호(토큰) 교환"에만 쓰인다.
///
/// 검증은 2단계로(변수 분리):
///  A) 폰1=허브(워치+폰2 2세션, 중계 없음) → 우리 다중세션 코드가 맞는지 신뢰되는 폰에서 확인.
///  B) 워치=태그(폰1+폰2 2세션, 폰1 중계) → 진짜 리스크인 "워치 2세션"을 확인.

// MARK: - 주소가 붙은 토큰 메시지 (JSON으로 직렬화해 WC/네트워크 어디로든 보냄)
struct AddressedToken: Codable {
    let from: String    // 보낸 기기의 역할 ID (TAG/ANCHOR1/ANCHOR2)
    let to: String      // 받을 기기의 역할 ID
    let token: Data     // NSKeyedArchiver로 아카이브한 NIDiscoveryToken
}

enum Chan { case wc, net }   // 이 피어에게 내 토큰을 보낼 채널

struct PeerSpec { let id: String; let chan: Chan }

/// 이 기기가 맡을 역할. 물리 기기마다 화면에서 자기 역할 버튼을 누른다.
struct Phase1Role: Identifiable {
    let id: String            // 버튼 제목 겸 식별자
    let myID: String          // 내 역할 ID
    let peers: [PeerSpec]      // 내가 거리 잴 상대들 (각자 세션 1개)
    let relays: Bool           // true면 나한테 안 온 메시지를 반대 채널로 중계(폰1 전용)
    var usesWC: Bool { relays || peers.contains { $0.chan == .wc } }
    var usesNet: Bool { relays || peers.contains { $0.chan == .net } }
}

enum Phase1Roles {
    static let TAG = "TAG", A1 = "ANCHOR1", A2 = "ANCHOR2"

    // A단계: 폰1이 허브로 2세션(중계 불필요). 다중세션 코드 자체를 폰에서 먼저 검증.
    static let aHub = Phase1Role(id: "A · 폰1=허브(2세션)", myID: A1,
        peers: [PeerSpec(id: TAG, chan: .wc), PeerSpec(id: A2, chan: .net)], relays: false)
    static let aWatch = Phase1Role(id: "A · 워치=태그", myID: TAG,
        peers: [PeerSpec(id: A1, chan: .wc)], relays: false)
    static let aPhone2 = Phase1Role(id: "A · 폰2=앵커", myID: A2,
        peers: [PeerSpec(id: A1, chan: .net)], relays: false)

    // B단계: 워치가 태그로 2세션. 폰1이 워치↔폰2 토큰을 중계. 진짜 리스크(워치 2세션) 검증.
    static let bWatch = Phase1Role(id: "B · 워치=태그(2세션)", myID: TAG,
        peers: [PeerSpec(id: A1, chan: .wc), PeerSpec(id: A2, chan: .wc)], relays: false)
    static let bAnchor1 = Phase1Role(id: "B · 폰1=앵커+중계", myID: A1,
        peers: [PeerSpec(id: TAG, chan: .wc)], relays: true)
    static let bAnchor2 = Phase1Role(id: "B · 폰2=앵커", myID: A2,
        peers: [PeerSpec(id: TAG, chan: .net)], relays: false)

    #if os(watchOS)
    static let all = [aWatch, bWatch]                   // 워치는 태그 역할만
    #else
    static let all = [aHub, aPhone2, bAnchor1, bAnchor2] // 폰은 앵커/허브 역할
    #endif
}

// MARK: - 피어별 링크(세션 + 상태)
final class PeerLink {
    let spec: PeerSpec
    let session: NISession
    var runningToken: Data?                       // 지금 돌고 있는 상대 토큰(묵은 토큰 덮어쓰기 추적)
    var lastConfig: NINearbyPeerConfiguration?    // 타임아웃 시 재실행용
    var stamps: [Date] = []                       // Hz 계산용 최근 콜백 시각
    init(spec: PeerSpec, session: NISession) { self.spec = spec; self.session = session }
}

// MARK: - UI 노출 상태
struct PeerState: Identifiable {
    let id: String
    var chan: String
    var distance: Float?
    var hz: Double
    var updates: Int
    var connected: Bool
}

final class MultiPeerNIManager: NSObject, ObservableObject {

    @Published var role: Phase1Role?
    @Published var peers: [PeerState] = []
    @Published var status: String = "역할 선택 대기"

    private var links: [String: PeerLink] = [:]
    private var sessionOwner: [ObjectIdentifier: String] = [:]   // NISession -> peerID 역인덱스
    private var wc: WCSession?
    private var retryTimer: Timer?
    #if os(iOS)
    private var net: NetworkTokenChannel?
    #endif

    #if os(watchOS)
    let platform = "WATCH"
    #else
    let platform = "PHONE"
    #endif

    // MARK: 시작
    func start(role: Phase1Role) {
        guard self.role == nil else { return }           // 멱등: 중복 시작 방지
        guard NISession.isSupported else { status = "이 기기는 NI 미지원(U1/U2 없음)"; return }
        self.role = role
        status = "\(role.myID) 시작 · 피어 [\(role.peers.map { $0.id }.joined(separator: ", "))]"

        // 피어별 세션 생성
        for spec in role.peers {
            let s = NISession()
            s.delegate = self
            links[spec.id] = PeerLink(spec: spec, session: s)
            sessionOwner[ObjectIdentifier(s)] = spec.id
        }
        peers = role.peers.map {
            PeerState(id: $0.id, chan: $0.chan == .wc ? "WC" : "NET",
                      distance: nil, hz: 0, updates: 0, connected: false)
        }

        if role.usesWC { setupWC() }
        #if os(iOS)
        if role.usesNet { setupNet() }
        #endif

        // 붙을 때까지 내 토큰들을 반복 전송(타이밍/묵은토큰 극복). 모든 피어가 실제 거리 갱신되면 멈춤.
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] t in
            guard let self = self else { t.invalidate(); return }
            self.shareMyTokens()
            if !self.peers.isEmpty, self.peers.allSatisfy({ $0.updates > 0 }) { t.invalidate() }
        }
    }

    private func setupWC() {
        guard WCSession.isSupported() else { status = "WCSession 미지원"; return }
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
            log:         { [weak self] s in self?.log("net: \(s)") })
        ch.start()
        net = ch
    }
    #endif

    // MARK: 내 토큰(피어별로 다름) 전송
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
            #else
            log("net 채널은 이 플랫폼에서 미지원(무시)")
            #endif
        }
    }

    // MARK: 수신 + (필요 시) 중계
    private func handleIncoming(_ data: Data, via: Chan) {
        guard let msg = try? JSONDecoder().decode(AddressedToken.self, from: data) else { return }
        if msg.to == role?.myID {
            deliver(msg)
        } else if role?.relays == true {
            let out: Chan = (via == .wc) ? .net : .wc   // 온 채널의 반대쪽으로 넘김
            send(data, on: out)
            log("중계 \(msg.from)→\(msg.to) (\(via == .wc ? "WC" : "NET")→\(out == .wc ? "WC" : "NET"))")
        }
    }

    private func deliver(_ msg: AddressedToken) {
        guard let link = links[msg.from] else { return }        // 내 피어가 아니면 무시
        guard link.runningToken != msg.token else { return }    // 같은 토큰이면 스킵(묵은 토큰 방지)
        guard let tok = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NIDiscoveryToken.self,
                                                                from: msg.token) else {
            log("peer \(msg.from) 토큰 언아카이브 실패"); return
        }
        link.runningToken = msg.token
        let config = NINearbyPeerConfiguration(peerToken: tok)
        link.lastConfig = config
        link.session.run(config)
        setPeer(msg.from) { $0.connected = true }
        log("peer \(msg.from) 토큰 수신(\(msg.token.count)B) · session.run")
    }

    // MARK: Hz/카운트
    private func recordUpdate(_ id: String) {
        guard let link = links[id] else { return }
        let now = Date()
        link.stamps.append(now)
        link.stamps.removeAll { now.timeIntervalSince($0) > 2.0 }
        let span = link.stamps.count >= 2 ? now.timeIntervalSince(link.stamps.first!) : 0
        let hz = span > 0.001 ? Double(link.stamps.count - 1) / span : 0
        setPeer(id) { $0.hz = hz; $0.updates += 1 }
    }

    private func setPeer(_ id: String, _ mut: @escaping (inout PeerState) -> Void) {
        DispatchQueue.main.async {
            guard let i = self.peers.firstIndex(where: { $0.id == id }) else { return }
            var s = self.peers[i]; mut(&s); self.peers[i] = s
        }
    }

    private func log(_ s: String) { print("[\(platform)/\(role?.myID ?? "-")] \(s)") }
}

// MARK: - NISessionDelegate (세션 -> 어떤 피어인지 sessionOwner로 역추적)
extension MultiPeerNIManager: NISessionDelegate {
    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard let id = sessionOwner[ObjectIdentifier(session)], let obj = nearbyObjects.first else { return }
        recordUpdate(id)
        setPeer(id) { $0.distance = obj.distance }
    }

    func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject],
                 reason: NINearbyObject.RemovalReason) {
        guard let id = sessionOwner[ObjectIdentifier(session)] else { return }
        setPeer(id) { $0.distance = nil }
        if reason == .timeout, let cfg = links[id]?.lastConfig { session.run(cfg) }  // 드롭 후 자동 회복
    }

    func sessionWasSuspended(_ session: NISession) {
        DispatchQueue.main.async { self.status = "세션 일시중단(백그라운드/워치 슬립?)" }
    }
    func sessionSuspensionEnded(_ session: NISession) {
        guard let id = sessionOwner[ObjectIdentifier(session)] else { return }
        if let cfg = links[id]?.lastConfig { session.run(cfg) }   // 재개 시 반드시 재실행
    }
    func session(_ session: NISession, didInvalidateWith error: Error) {
        DispatchQueue.main.async { self.status = "세션 무효화: \(error.localizedDescription)" }
    }
}

// MARK: - WCSessionDelegate (companion 토큰 채널 + 중계 입구)
extension MultiPeerNIManager: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        DispatchQueue.main.async { self.shareMyTokens() }
    }
    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        handleIncoming(messageData, via: .wc)
    }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let data = userInfo["m"] as? Data { handleIncoming(data, via: .wc) }
    }
    func sessionReachabilityDidChange(_ session: WCSession) {
        shareMyTokens()
    }
    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }
    #endif
}
