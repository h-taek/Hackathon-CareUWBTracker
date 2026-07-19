import SwiftUI

/// 앱 진입 시 먼저 뜨는 선택 화면. Phase 0(검증된 단일 거리)과 Phase 1(2세션 테스트)을 고른다.
/// Phase 0 코드는 손대지 않고 그대로 두고, 여기서 한 번 탭으로 들어간다.
struct RootView: View {
    enum Screen { case menu, phase0, phase1, telemetry, ingest }
    @State private var screen: Screen = .menu

    var body: some View {
        switch screen {
        case .menu:
            // 워치 작은 화면에서 버튼이 넘치므로 ScrollView로 감싼다(Digital Crown/스와이프 스크롤). 폰에도 무해.
            ScrollView {
                VStack(spacing: 14) {
                    Text("NI Spike").font(.headline)
                    Button("Phase 0 · 거리 1개 (검증됨)") { screen = .phase0 }
                        .buttonStyle(.borderedProminent)
                    Button("Phase 1 · 2세션 테스트") { screen = .phase1 }
                        .buttonStyle(.borderedProminent)
                    Button("Phase 2 · 텔레메트리(가속도)") { screen = .telemetry }
                        .buttonStyle(.borderedProminent)
                    Button("Phase 3 · Ingest(거리+accel→서버)") { screen = .ingest }
                        .buttonStyle(.borderedProminent)
                }
                .font(.caption)
                .padding()
            }
        case .phase0:
            ContentView()
        case .phase1:
            Phase1ContentView()
        case .telemetry:
            TelemetryView()
        case .ingest:
            IngestView()
        }
    }
}
