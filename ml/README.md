# fall_ml — 낙상 AI 정밀판정 학습 파이프 (오프라인 개발 도구)

고전 감지기(`demo/detection/fall.js`) 위에 얹을 2단계 AI 정밀판정(research 02 §6-하이브리드)의
**학습·비교 코드**. 배포 서버(Node·무의존)와 분리된 오프라인 도구다.

## 환경 (한 번만)

시스템 Python은 3.14뿐이라 ML 휠 호환이 불확실 → **uv로 3.12 격리 venv** 사용(결정: PROGRESS_HT 2026-07-21).

```bash
# 1) 격리 venv (레포 루트, .gitignore됨)
uv venv --python 3.12 .venv-ml

# 2) 코어 휠
uv pip install --python .venv-ml/bin/python numpy scipy scikit-learn xgboost lightgbm
# (1D-CNN 비교 시) uv pip install --python .venv-ml/bin/python torch

# 3) [필수] OpenMP 런타임 — xgboost/lightgbm 네이티브 의존. 휠만으론 부족.
brew install libomp
```

> `libomp` 없으면 `import xgboost`가 `libomp.dylib could not be loaded`로 죽는다(파이썬 패키지 아님, macOS 네이티브 라이브러리).

검증: `.venv-ml/bin/python -c "import xgboost, lightgbm; print('ok')"`

## 파이프라인

| 단계 | 파일 | 하는 일 |
|---|---|---|
| 규격 | `features.py` | 충격윈도우(150샘플) + 코어 19특징 **정본 정의** (research 02 §5.3/§5.4). 학습·Node 이식의 유일 진실 |
| 추출 | `extract.py` | 마스터 CSV 스트리밍 → placement 필터 → trial별 특징표 산출 |
| 학습 | (예정) | GroupKFold 5-fold LOSO로 XGBoost·LightGBM·로지스틱 학습, 고전 베이스라인(§6.1) 대비 비교 |

### 특징표 산출

```bash
.venv-ml/bin/python ml/extract.py \
    ml/datasets/_normalized/falls_all_50hz.csv \
    --placement waist \
    --out ml/_out/features_waist.csv
```

산출: `_out/features_waist.csv` — 15,883행(낙상 6,938/ADL 8,945), 열 = 19특징 + `is_fall,subject,dataset,activity,trial,placement`.
`subject`는 `<dataset>:<subj>` 전역 유일(LOSO 그룹키). `_out/`은 gitignore(재현 가능).

## 테스트

```bash
cd ml && ../.venv-ml/bin/python -m unittest test_features -v
```

합성 신호로 창 추출(시프트/패딩)·각 특징의 분석적 성질 검증(7 케이스).
