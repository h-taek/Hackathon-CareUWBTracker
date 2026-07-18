import SwiftUI

/// Phase 1 화면: 먼저 이 기기의 역할을 고르고(A/B 단계별), 고르면 피어별 거리·Hz·연결상태를 나열한다.
/// 각 물리 기기에서 자기 역할 버튼만 누르면 된다. (워치엔 태그 역할만, 폰엔 앵커/허브 역할만 노출)
struct Phase1ContentView: View {
    @StateObject private var mgr = MultiPeerNIManager()

    var body: some View {
        if mgr.role == nil {
            roleChooser
        } else {
            liveReadout
        }
    }

    private var roleChooser: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text("이 기기의 역할 선택").font(.headline)
                Text(mgr.platform).font(.caption).foregroundStyle(.secondary)
                Text("A = 폰1 허브로 코드 검증 · B = 워치 2세션 검증")
                    .font(.caption2).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                ForEach(Phase1Roles.all) { r in
                    Button(r.id) { mgr.start(role: r) }
                        .font(.caption)
                        .buttonStyle(.borderedProminent)
                }
            }
            .padding()
        }
    }

    private var liveReadout: some View {
        VStack(spacing: 8) {
            Text(mgr.role?.myID ?? "-").font(.headline)
            ForEach(mgr.peers) { p in
                HStack(spacing: 6) {
                    Text(p.id).font(.caption).frame(width: 68, alignment: .leading)
                    Text(p.distance.map { String(format: "%.2f m", $0) } ?? "-- m")
                        .font(.system(.body, design: .rounded)).bold().monospacedDigit()
                    Spacer()
                    Text(String(format: "%.0f Hz", p.hz)).font(.caption2).monospacedDigit()
                    Text(p.chan).font(.caption2).foregroundStyle(.secondary)
                    Circle().fill(p.connected ? Color.green : Color.orange).frame(width: 8, height: 8)
                }
            }
            Text(mgr.status)
                .font(.caption2).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}
