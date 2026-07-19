  import SwiftUI

/// iOS/watchOS 공용 스파이크 화면. 두 타깃에 함께 add 한다.
/// 거리(m), 업데이트율(Hz), 누적 콜백 수, 피어 연결/상태를 크게 표시해 육안 실측이 쉽도록 한다.
struct ContentView: View {
    @StateObject private var mgr = NIRangingManager()

    var body: some View {
        VStack(spacing: 6) {
            Text(mgr.deviceRole)
                .font(.caption).foregroundStyle(.secondary)

            Text(mgr.distance.map { String(format: "%.2f m", $0) } ?? "-- m")
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .foregroundStyle(mgr.distance == nil ? .secondary : .primary)
                .monospacedDigit()

            Text(String(format: "%.1f Hz", mgr.updateHz))
                .font(.headline).monospacedDigit()

            Text("업데이트 \(mgr.totalUpdates)")
                .font(.caption2).foregroundStyle(.secondary).monospacedDigit()

            Text(mgr.peerConnected ? "● 피어 연결됨" : "○ 피어 대기")
                .font(.caption)
                .foregroundStyle(mgr.peerConnected ? .green : .orange)

            Text(mgr.status)
                .font(.caption2).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .onAppear { mgr.start() }
    }
}
