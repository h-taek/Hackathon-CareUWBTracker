#if os(iOS)
import Foundation

/// 서버 우편함으로 NI 토큰을 주고받는다. **폰↔폰 구간 전용**(워치는 로컬 네트워크가 막혀 있어 못 쓴다).
///
/// 왜 이게 있나 — 예전엔 Bonjour로 두 폰이 서로를 **찾아서** 직접 붙었다. 그런데 붙기 전에
/// "여기 누구 있나"를 멀티캐스트로 외치는 단계가 있고, **깨지는 건 항상 그 단계였다**:
/// AP가 단말끼리 못 붙게 막거나(client isolation) 멀티캐스트를 억제하면, 인터넷은 멀쩡한데
/// 옆 단말만 안 보인다. 이름이 같은 Wi-Fi여도 2.4/5GHz나 게스트망으로 갈리면 마찬가지다.
///
/// 서버는 두 폰이 **이미 주소를 아는** 유일한 지점이다(메인폰은 여기로 초당 50번 POST한다).
/// 그래서 찾는 단계가 통째로 없어지고 "놓고 가져오기"만 남는다. 우편함에 편지를 맡기는 것과
/// 같아서, 두 폰이 서로를 볼 수 없어도 각자 우편함까지만 닿으면 된다.
///
/// 같은 토큰을 여러 번 받아도 무해하다 — 매니저가 두 번째를 버린다(`PeerLink.runningToken` 비교).
final class TokenMailboxClient {

    /// 조회 주기. 토큰은 붙을 때 한 번만 필요하고 그 뒤론 UWB 라디오끼리 직접 재므로 촘촘할 이유가 없다.
    private static let pollInterval: TimeInterval = 1.0

    private let host: () -> String        // 매번 읽는다 — 화면에서 서버 주소를 고칠 수 있다
    private let inboxes: [String]         // 내가 가져갈 우편함(내 것 + 중계할 것)
    private let onMessage: (Data) -> Void
    private var timer: Timer?

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral   // 캐시 없는 세션 — 묵은 토큰 재사용 방지
        cfg.timeoutIntervalForRequest = 2
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    init(host: @escaping () -> String, inboxes: [String], onMessage: @escaping (Data) -> Void) {
        self.host = host
        self.inboxes = inboxes
        self.onMessage = onMessage
    }

    func start() {
        timer?.invalidate()
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            self?.poll()
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        session.invalidateAndCancel()
    }

    /// 내 토큰을 우편함에 놓는다. 본문은 WCSession으로 보내는 것과 같은 `AddressedToken` JSON이다(부호화 공유).
    func post(_ data: Data) {
        guard let url = endpoint() else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.httpBody = data
        session.dataTask(with: req).resume()   // 실패해도 1.5초 뒤 재전송이 다시 시도한다
    }

    // MARK: 조회
    private func poll() {
        for inbox in inboxes { fetch(inbox) }
    }

    private func fetch(_ inbox: String) {
        guard let base = endpoint(),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
        components.queryItems = [URLQueryItem(name: "to", value: inbox)]
        guard let url = components.url else { return }
        session.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self, let data = data else { return }
            // 응답의 각 원소를 그대로 다시 직렬화해 넘긴다. 서버가 덧붙인 `at`은 AddressedToken
            // 디코딩에서 무시되므로, 매니저는 WCSession으로 받은 것과 똑같이 다루면 된다.
            guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let items = root["tokens"] as? [[String: Any]] else { return }
            for item in items {
                guard let one = try? JSONSerialization.data(withJSONObject: item) else { continue }
                self.onMessage(one)
            }
        }.resume()
    }

    private func endpoint() -> URL? {
        let h = host().trimmingCharacters(in: .whitespaces)
        guard !h.isEmpty else { return nil }
        return URL(string: "http://\(h)/ni/token")
    }
}
#endif
