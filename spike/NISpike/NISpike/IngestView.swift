import SwiftUI

/// Phase 3 화면(E3). 워치=측정 송신(거리 r_A + accel), 폰=게이트웨이(수신 -> ingest POST).
/// 한 View로 양 플랫폼. 폰 전용(서버 host 입력·POST 상태)만 `#if os(iOS)`로 감싼다.
struct IngestView: View {
    @StateObject private var mgr = IngestManager()

    var body: some View {
        // 워치 작은 화면에서 내용이 넘치므로 ScrollView로 감싼다(스크롤 가능). 폰에도 무해.
        ScrollView {
        VStack(spacing: 10) {
            Text(mgr.platform == "WATCH" ? "측정 송신 (r_A+accel)" : "게이트웨이 (ingest POST)")
                .font(.headline)

            HStack {
                Circle().fill(mgr.peerConnected ? .green : .gray).frame(width: 8, height: 8)
                Text(mgr.peerConnected ? "레인징 연결" : "토큰 교환 대기")
                    .font(.caption2).foregroundStyle(.secondary)
            }

            // r_A 거리
            HStack {
                Text("r_A").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(mgr.distance.map { String(format: "%.2f m", $0) } ?? "—")
                    .bold().monospacedDigit()
            }

            if let f = mgr.lastFrame {
                Divider()
                axisRow("x", f.ax); axisRow("y", f.ay); axisRow("z", f.az)
                HStack {
                    Text("SMV").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text(String(format: "%.2f g", f.smv)).monospacedDigit()
                }
                Text("seq \(f.seq)").font(.caption2).foregroundStyle(.secondary)
            }

            Divider()
            HStack(spacing: 6) {
                Text(String(format: "%.0f Hz", mgr.hz)).monospacedDigit()
                #if os(iOS)
                Text("· POST \(mgr.postCount)")
                #endif
            }
            .font(.caption)

            #if os(iOS)
            VStack(spacing: 4) {
                HStack {
                    Text("서버").font(.caption2).foregroundStyle(.secondary)
                    TextField("host:port", text: $mgr.serverHost)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.caption.monospaced())
                }
                if !mgr.lastPostStatus.isEmpty {
                    Text(mgr.lastPostStatus).font(.caption2).foregroundStyle(.secondary)
                }
            }
            #endif

            Button(mgr.running ? "정지" : "시작") {
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
    }

    private func axisRow(_ label: String, _ v: Double) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary).frame(width: 16)
            Text(String(format: "%+.3f g", v)).monospacedDigit()
            Spacer()
        }
    }
}
