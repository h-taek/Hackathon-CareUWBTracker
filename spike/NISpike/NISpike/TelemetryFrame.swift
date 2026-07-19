import Foundation

/// 워치(태그) → 메인폰 내부 텔레메트리 프레임. (E1 샘플 + E2 전송의 공용 데이터 계약)
///
/// 주의: 이건 **최종 ingest 스키마가 아니다**. spec 03 §5(폰→서버)는 m/s²·NI 거리 결합·source="ni"까지 포함한
/// 별도 계약이다. 여기 프레임은 워치→폰 내부 구간 전용이며 단위는 CoreMotion 네이티브인 **g**다.
/// g→m/s² 변환은 E3에서 메인폰(게이트웨이)이 담당한다. 거리는 워치가 측정해 `ranges`에 담아 보낸다.
struct TelemetryFrame: Codable, Equatable {
    let seq: Int          // 워치가 붙이는 순번(유실·순서 확인용)
    let ts: Double        // epoch 밀리초
    let ax: Double        // raw accelerometer 3축(중력 포함), 단위 g
    let ay: Double
    let az: Double
    let smv: Double        // Signal Magnitude Vector = sqrt(ax²+ay²+az²). 정지 시 약 1g(spec 04 §2)
    // 태그(워치)↔각 앵커 거리(m). key=anchorId(예: "phoneMain"), value=거리. E3에서 워치 NI로 채운다.
    // 배열이 아니라 맵이라, 서브폰(anchorId="phoneSub")이 붙으면 원소만 추가되고 스키마는 안 바뀐다.
    // 앵커 세션이 아직 안 붙었으면 nil(또는 빈 맵) — 폰은 채워진 것만 ingest ranges로 내보낸다.
    let ranges: [String: Double]?

    /// 워치 샘플에서 프레임을 만든다. smv는 여기서 계산해 박제한다(수신측은 디코드값을 그대로 쓴다).
    init(seq: Int, ts: Double, ax: Double, ay: Double, az: Double, ranges: [String: Double]? = nil) {
        self.seq = seq
        self.ts = ts
        self.ax = ax
        self.ay = ay
        self.az = az
        self.smv = TelemetryFrame.smv(ax: ax, ay: ay, az: az)
        self.ranges = ranges
    }

    /// SMV = sqrt(ax²+ay²+az²). 순수 함수라 단위 테스트 가능. 정지 시 ~1g, 낙상 충격 시 급증(spec 04 §3).
    static func smv(ax: Double, ay: Double, az: Double) -> Double {
        (ax * ax + ay * ay + az * az).squareRoot()
    }
}
