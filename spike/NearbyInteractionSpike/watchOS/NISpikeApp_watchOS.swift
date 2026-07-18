import SwiftUI

/// watchOS 앱 진입점. 이 파일은 Watch App 타깃에만 추가한다.
@main
struct NISpikeApp_watchOS: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}
