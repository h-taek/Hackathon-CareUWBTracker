import Foundation
import Network

/// 폰↔폰 메시지 파이프. Bonjour + peer-to-peer(AWDL, 직접 Wi-Fi)로 붙어 임의의 바이트 프레임을 주고받는다.
///
/// Phase 1 전용(폰끼리만). watchOS는 로컬 네트워크가 막혀 있어 워치는 이 채널을 쓰지 않는다(WCSession만).
/// - 예전엔 "내 토큰 하나"만 보냈지만, Phase 1은 피어별로 다른 토큰 + 중계 메시지를 여러 번 보내야 해서
///   범용 파이프로 일반화했다: `broadcast(_)`로 아무 바이트나 보내고, 받은 프레임마다 `onMessage`가 불린다.
/// - 연결이 붙는 순간 `onConnected`를 불러, 매니저가 그 시점의 내 토큰들을 밀어넣게 한다.
///
/// 자기루프 방지: 광고 서비스 이름에 실행마다 고유한 `instanceID`(UUID)를 실어, 탐색 중 자기 자신을 만나면 연결하지 않는다.
final class NetworkTokenChannel {

    /// Bonjour 서비스 타입. Info.plist의 NSBonjourServices와 일치해야 함.
    static let serviceType = "_nispike._tcp"

    private let instanceID = UUID().uuidString
    private var listener: NWListener?
    private var browser: NWBrowser?
    private var connections: [NWConnection] = []
    private let queue = DispatchQueue(label: "NetworkTokenChannel")

    private let onMessage: (Data) -> Void
    private let onConnected: () -> Void
    private let log: (String) -> Void

    init(onMessage: @escaping (Data) -> Void,
         onConnected: @escaping () -> Void,
         log: @escaping (String) -> Void) {
        self.onMessage = onMessage
        self.onConnected = onConnected
        self.log = log
    }

    // MARK: 시작 / 종료
    func start() {
        queue.async {
            self.startListener()
            self.startBrowser()
        }
    }

    func stop() {
        queue.async {
            self.listener?.cancel(); self.listener = nil
            self.browser?.cancel(); self.browser = nil
            self.connections.forEach { $0.cancel() }
            self.connections.removeAll()
        }
    }

    /// 준비된 모든 연결로 프레임을 보낸다(폰이 2대뿐이라 사실상 상대 1대에게 전달).
    func broadcast(_ data: Data) {
        queue.async {
            for c in self.connections where c.state == .ready { self.send(data, over: c) }
        }
    }

    // MARK: 광고
    private func startListener() {
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        do {
            let l = try NWListener(using: params)
            l.service = NWListener.Service(name: instanceID, type: Self.serviceType)
            l.newConnectionHandler = { [weak self] conn in self?.adopt(conn) }
            l.stateUpdateHandler = { [weak self] state in self?.log("listener \(state)") }
            l.start(queue: queue)
            listener = l
        } catch {
            log("listener 생성 실패: \(error)")
        }
    }

    // MARK: 탐색
    private func startBrowser() {
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: params)
        b.stateUpdateHandler = { [weak self] state in self?.log("browser \(state)") }
        b.browseResultsChangedHandler = { [weak self] _, changes in
            guard let self = self else { return }
            for change in changes {
                guard case let .added(result) = change else { continue }
                if case let .service(name, _, _, _) = result.endpoint, name == self.instanceID {
                    self.log("내 서비스 발견 — 연결 안 함(자기루프 방지)")
                    continue
                }
                let conn = NWConnection(to: result.endpoint, using: params)
                self.adopt(conn)
            }
        }
        b.start(queue: queue)
        browser = b
    }

    // MARK: 연결 채택
    private func adopt(_ conn: NWConnection) {
        connections.append(conn)
        conn.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                self.log("connection ready")
                self.receiveLoop(over: conn)
                self.onConnected()             // 매니저가 이 시점의 내 토큰들을 밀어넣도록
            case .failed(let e):
                self.log("connection 실패: \(e)")
                self.connections.removeAll { $0 === conn }
            case .cancelled:
                self.connections.removeAll { $0 === conn }
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    // MARK: 길이접두(4B big-endian) 프레임 송신
    private func send(_ payload: Data, over conn: NWConnection) {
        var lenBE = UInt32(payload.count).bigEndian
        var frame = Data(bytes: &lenBE, count: 4)
        frame.append(payload)
        conn.send(content: frame, completion: .contentProcessed { [weak self] err in
            if let err = err { self?.log("send 실패: \(err)") }
            else { self?.log("프레임 송신(\(payload.count)B)") }
        })
    }

    // MARK: 길이접두 프레임 수신 — 한 프레임 받으면 콜백하고 다시 다음 프레임을 기다린다(연속 수신)
    private func receiveLoop(over conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] header, _, _, err in
            guard let self = self else { return }
            if let err = err { self.log("헤더 수신 실패: \(err)"); return }
            guard let header = header, header.count == 4 else { return }   // EOF/취소
            let len = header.reduce(0) { ($0 << 8) | Int($1) }
            guard len > 0, len < 100_000 else { self.log("비정상 프레임 길이 \(len)"); return }
            conn.receive(minimumIncompleteLength: len, maximumLength: len) { [weak self] payload, _, _, err in
                guard let self = self else { return }
                if let err = err { self.log("payload 수신 실패: \(err)"); return }
                guard let payload = payload, payload.count == len else { return }
                self.log("프레임 수신(\(len)B)")
                self.onMessage(payload)
                self.receiveLoop(over: conn)   // 다음 프레임 대기
            }
        }
    }
}
