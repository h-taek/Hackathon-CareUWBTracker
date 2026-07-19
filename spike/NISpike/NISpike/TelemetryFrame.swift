import Foundation

/// 워치(태그) → 메인폰 내부 텔레메트리 프레임. (E1 샘플 + E2 전송의 공용 데이터 계약)
///
/// 주의: 이건 **최종 ingest 스키마가 아니다**. spec 03 §5(폰→서버)는 m/s²·NI 거리 결합·source="ni"까지 포함한
/// 별도 계약이다. 여기 프레임은 워치→폰 내부 구간 전용이며 단위는 CoreMotion 네이티브인 **g**다.
/// g→m/s² 변환과 NI 거리(`range`) 채우기는 E3에서 메인폰이 담당한다(현재 `range`는 자리만).
struct TelemetryFrame: Codable, Equatable {
    let seq: Int          // 워치가 붙이는 순번(유실·순서 확인용)
    let ts: Double        // epoch 밀리초
    let ax: Double        // raw accelerometer 3축(중력 포함), 단위 g
    let ay: Double
    let az: Double
    let smv: Double        // Signal Magnitude Vector = sqrt(ax²+ay²+az²). 정지 시 약 1g(spec 04 §2)
    let range: Double?     // 태그↔메인앵커 거리(m). E3에서 NI로 채움. 지금은 nil.

    /// 워치 샘플에서 프레임을 만든다. smv는 여기서 계산해 박제한다(수신측은 디코드값을 그대로 쓴다).
    init(seq: Int, ts: Double, ax: Double, ay: Double, az: Double, range: Double? = nil) {
        self.seq = seq
        self.ts = ts
        self.ax = ax
        self.ay = ay
        self.az = az
        self.smv = TelemetryFrame.smv(ax: ax, ay: ay, az: az)
        self.range = range
    }

    /// SMV = sqrt(ax²+ay²+az²). 순수 함수라 단위 테스트 가능. 정지 시 ~1g, 낙상 충격 시 급증(spec 04 §3).
    static func smv(ax: Double, ay: Double, az: Double) -> Double {
        (ax * ax + ay * ay + az * az).squareRoot()
    }
}
