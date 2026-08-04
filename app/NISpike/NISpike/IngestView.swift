import SwiftUI

/// 최종 화면. 워치=측정 송신(앵커별 거리 + accel), 폰=게이트웨이(수신 -> ingest POST).
/// 한 View로 양 플랫폼. 폰 전용(역할 선택·서버 host·POST)만 `#if os(iOS)`로 감싼다.
///
/// 버튼 2개(독립):
///  - 워치 연결: NI/WCSession 링크(거리 측정) 시작·정지
///  - 서버 전송: ingest POST 링크 시작·정지 (메인폰 전용)
struct IngestView: View {
    @StateObject private var mgr = IngestManager()

    var body: some View {
        ScrollView {   // 워치 작은 화면 대비 스크롤. 폰에도 무해.
        VStack(spacing: 10) {
            Text(mgr.platform == "WATCH" ? "측정 송신 (거리+accel)" : "게이트웨이 (ingest POST)")
                .font(.headline)

            #if os(iOS)
            // 폰 역할 선택(연결 중엔 잠금 — 역할 바꾸려면 먼저 정지).
            Picker("역할", selection: $mgr.phoneRole) {
                ForEach(IngestManager.PhoneRole.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .disabled(mgr.rangingRunning)
            #endif

            // 연결 상태 점
            HStack {
                Circle().fill(mgr.anyPeerConnected ? .green : .gray).frame(width: 8, height: 8)
                Text(mgr.anyPeerConnected ? "레인징 연결" : (mgr.rangingRunning ? "토큰 교환 대기" : "정지"))
                    .font(.caption2).foregroundStyle(.secondary)
            }

            // 앵커별 거리
            if mgr.peers.isEmpty {
                Text("앵커 없음").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(mgr.peers) { p in
                    HStack {
                        Circle().fill(p.connected ? .green : .gray).frame(width: 6, height: 6)
                        Text(p.id).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Text(p.distance.map { String(format: "%.2f m", $0) } ?? "—")
                            .bold().monospacedDigit()
                        Text(String(format: "%.0fHz", p.hz))
                            .font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
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
                #if os(watchOS)
                Text(String(format: "센서 수집 %.0f Hz", mgr.hz)).monospacedDigit()   // 가속도 콜백 수집 Hz(전송 스로틀 전). 위 앵커 행 Hz = UWB.
                #else
                Text(String(format: "워치 수신 %.0f Hz", mgr.hz)).monospacedDigit()    // 워치→폰 프레임 실제 도착 Hz
                Text("· POST \(mgr.postCount)")
                #endif
            }
            .font(.caption)

            #if os(iOS)
            // 서버 주소는 두 역할 모두 쓴다. 메인폰은 ingest를 POST하고, 서브폰은 NI 토큰을
            // 여기서 가져온다(폰↔폰 토큰이 이 서버를 경유한다 — 서브폰이 비어 있으면 안 붙는다).
            VStack(spacing: 4) {
                HStack {
                    Text("서버").font(.caption2).foregroundStyle(.secondary)
                    TextField("host:port", text: $mgr.serverHost)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.caption.monospaced())
                }
                if mgr.phoneRole == .main, !mgr.lastPostStatus.isEmpty {
                    Text(mgr.lastPostStatus).font(.caption2).foregroundStyle(.secondary)
                }
            }
            #endif

            // 버튼 1) 워치 연결(거리 측정) 시작·정지
            Button(mgr.rangingRunning ? "워치 연결 정지" : "워치 연결 시작") {
                if mgr.rangingRunning { mgr.stopRanging(signalPeer: true) } else { mgr.startRanging() }
            }
            .font(.caption)
            .buttonStyle(.borderedProminent)

            // 버튼 2) 서버 전송 시작·정지 (메인폰 전용, 워치 연결과 독립)
            #if os(iOS)
            if mgr.phoneRole == .main {
                Button(mgr.serverPosting ? "서버 전송 정지" : "서버 전송 시작") {
                    if mgr.serverPosting { mgr.stopPosting() } else { mgr.startPosting() }
                }
                .font(.caption)
                .buttonStyle(.bordered)
                .tint(mgr.serverPosting ? .red : .blue)
            }
            #endif

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
