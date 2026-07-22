import SwiftUI

/// 앱 진입 화면. 최종 측위·텔레메트리 화면(IngestView) 하나만 남긴다.
/// (옛 Phase 0~2 실험 화면은 제거됨 — 최신 테스트 경로만 유지.)
struct RootView: View {
    var body: some View {
        IngestView()
    }
}
