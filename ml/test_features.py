"""features.py 검증 — 합성 신호로 창 추출·각 특징의 분석적 성질 확인.
실행: cd ml && ../.venv-ml/bin/python -m unittest test_features -v
"""
import unittest
import numpy as np

import features as F


def const_trial(n, g=(0.0, 0.0, 1.0)):
    ax = np.full(n, g[0]); ay = np.full(n, g[1]); az = np.full(n, g[2])
    return ax, ay, az


class TestWindow(unittest.TestCase):
    def test_long_trial_shifts_no_pad(self):
        # 정점이 중앙 근처 → 길이 150 창, 실제 샘플만
        ax, ay, az = const_trial(1000)
        az[500] = 8.0  # 충격
        wax, way, waz, s = F.extract_window(ax, ay, az)
        self.assertEqual(len(s), F.WINDOW)
        self.assertAlmostEqual(s.max(), 8.0, places=6)

    def test_peak_near_start_shifts_inward(self):
        # 정점이 맨 앞 → 시프트로 경계 안에 창을 잡고 정점 포함
        ax, ay, az = const_trial(1000)
        az[2] = 9.0
        _, _, _, s = F.extract_window(ax, ay, az)
        self.assertEqual(len(s), F.WINDOW)
        self.assertAlmostEqual(s.max(), 9.0, places=6)

    def test_short_trial_pads_to_window(self):
        # 길이<150 → 가장자리 복제로 150 채움
        ax, ay, az = const_trial(80)
        az[40] = 7.0
        _, _, _, s = F.extract_window(ax, ay, az)
        self.assertEqual(len(s), F.WINDOW)
        self.assertAlmostEqual(s.max(), 7.0, places=6)


class TestFeatures(unittest.TestCase):
    def test_constant_signal(self):
        # 정지 1g 상수 → 변동성 0, 에너지·rms·mean 1, 정지비율 1, skew/kurt 0(가드)
        f = F.compute_features(*const_trial(300))
        self.assertAlmostEqual(f["smv_std"], 0.0, places=9)
        self.assertAlmostEqual(f["smv_range"], 0.0, places=9)
        self.assertAlmostEqual(f["smv_mean"], 1.0, places=6)
        self.assertAlmostEqual(f["smv_rms"], 1.0, places=6)
        self.assertAlmostEqual(f["smv_energy"], 1.0, places=6)
        self.assertAlmostEqual(f["post_still_ratio"], 1.0, places=6)
        self.assertEqual(f["smv_skew"], 0.0)
        self.assertEqual(f["smv_kurtosis"], 0.0)
        self.assertAlmostEqual(f["tilt_change"], 0.0, places=6)

    def test_fall_shape(self):
        # 정지 → 자유낙하(≈0g) → 충격(8g) → 정지: 낙상 지문 확인
        n = 400
        ax, ay, az = const_trial(n)
        ff_start, ff_end = 150, 170     # 자유낙하 20샘플
        az[ff_start:ff_end] = 0.02
        impact = ff_end                 # 충격 인덱스
        az[impact] = 8.0
        f = F.compute_features(ax, ay, az)
        self.assertGreater(f["smv_max"], 7.9)
        self.assertLess(f["smv_min"], 0.1)                 # 자유낙하 최저
        self.assertGreater(f["smv_range"], 7.8)
        # 자유낙하 지속 ≈ (impact - freefall최저)/50, 20샘플 근처 → 0.3~0.45s
        self.assertGreater(f["freefall_dur"], 0.2)
        self.assertGreater(f["impact_slope"], 10.0)        # 급격한 충격
        self.assertLess(f["post_activity"], 0.05)          # 충격 후 정지
        self.assertGreater(f["post_still_ratio"], 0.9)

    def test_tilt_change_vertical_to_horizontal(self):
        # 서있음(중력 z축) → 누움(중력 x축): 각도차 ≈ 90°
        n = 300
        ax = np.zeros(n); ay = np.zeros(n); az = np.zeros(n)
        az[:150] = 1.0   # 앞 절반 중력 z
        ax[150:] = 1.0   # 뒤 절반 중력 x
        # 충격 스파이크로 창이 전체를 덮게
        az[150] = 5.0
        f = F.compute_features(ax, ay, az)
        self.assertGreater(f["tilt_change"], 70.0)

    def test_vector_order_and_finiteness(self):
        v = F.feature_vector(*const_trial(300))
        self.assertEqual(len(v), len(F.FEATURE_NAMES))
        self.assertEqual(len(F.FEATURE_NAMES), 19)
        self.assertTrue(np.all(np.isfinite(v)))


if __name__ == "__main__":
    unittest.main()
