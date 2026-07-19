import SwiftUI

/// Phase 2 화면. 워치=가속도 송신(3축·SMV·peak·전송Hz), 폰=수신(프레임·수신Hz·카운트).
/// 한 View로 양 플랫폼을 처리하고, 워치 전용 표시(peak)만 `#if os(watchOS)`로 감싼다.
struct TelemetryView: View {
    @StateObject private var mgr = TelemetryManager()

    var body: some View {
        VStack(spacing: 10) {
            Text(mgr.platform == "WATCH" ? "가속도 송신" : "가속도 수신")
                .font(.headline)

            if let f = mgr.lastFrame {
                VStack(spacing: 4) {
                    axisRow("x", f.ax)
                    axisRow("y", f.ay)
                    axisRow("z", f.az)
                    Divider()
                    HStack {
                        Text("SMV").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text(String(format: "%.2f g", f.smv)).bold().monospacedDigit()
                    }
                    #if os(watchOS)
                    HStack {
                        Text("peak").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text(String(format: "%.2f g", mgr.peakSMV)).monospacedDigit()
                            .foregroundStyle(mgr.peakSMV > 2.5 ? .red : .primary)
                    }
                    #endif
                    Text("seq \(f.seq)").font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                Text("데이터 없음").font(.caption).foregroundStyle(.secondary)
            }

            HStack(spacing: 6) {
                Text(String(format: "%.0f Hz", mgr.hz)).monospacedDigit()
                if mgr.platform == "PHONE" { Text("· rx \(mgr.count)") }
            }
            .font(.caption)

            Button(mgr.running ? "정지" : (mgr.platform == "WATCH" ? "샘플 시작" : "수신 시작")) {
                if mgr.running { mgr.stop() } else { mgr.start() }
            }
            .font(.caption)
            .buttonStyle(.borderedProminent)

            Text(mgr.status)
                .font(.caption2).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private func axisRow(_ label: String, _ v: Double) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 16)
            Text(String(format: "%+.3f g", v)).monospacedDigit()
            Spacer()
        }
    }
}
