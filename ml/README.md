# fall_ml — 낙상 AI 정밀판정 학습 파이프 (오프라인 개발 도구)

고전 감지기(`server/detection/fall.js`) 위에 얹을 2단계 AI 정밀판정(research 02 §6-하이브리드)의
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
| 공용 | `eval_common.py` | 분할(LOSO/LODO)·지표·기준선. **부스팅/torch 미의존** — train과 train_cnn이 이걸 공유해 OpenMP 이중 초기화(segfault) 회피 |
| 학습(트리) | `train.py` | 특징표로 XGBoost·LightGBM·로지스틱 학습, GroupKFold LOSO/LODO OOF 비교 (research 04) |
| 학습(딥러닝) | `train_cnn.py` | 원시 충격 창으로 1D-CNN 학습(방향불변 4채널 기본, MPS/CPU). LODO에서 트리에 밀려 보류(§04 §3.5) |

> **모델 결론(research 04):** LightGBM 확정. 처음 보는 센서(LODO) 균형정확도 95.3%로 고전 베이스라인(87.7%) 상회, 1D-CNN(89.5%) 상회.

### 특징표 산출

```bash
.venv-ml/bin/python ml/extract.py \
    ml/datasets/_normalized/falls_all_50hz.csv \
    --placement waist \
    --out ml/_out/features_waist.csv
```

산출: `_out/features_waist.csv` — 15,883행(낙상 6,938/ADL 8,945), 열 = 19특징 + `is_fall,subject,dataset,activity,trial,placement`.
`subject`는 `<dataset>:<subj>` 전역 유일(LOSO 그룹키). `_out/`은 gitignore(재현 가능).

### 학습·비교

```bash
# 트리 3종 (수 초) — 처음 보는 사람(loso) / 처음 보는 센서(lodo)
.venv-ml/bin/python ml/train.py --mode loso --report ml/_out/train_loso.txt
.venv-ml/bin/python ml/train.py --mode lodo --report ml/_out/train_lodo.txt

# 1D-CNN (torch 필요, Apple Silicon은 MPS 자동 사용, fold당 6~9초)
uv pip install --python .venv-ml/bin/python torch
.venv-ml/bin/python ml/train_cnn.py --mode lodo --report ml/_out/train_cnn_lodo.txt
```

- `--mode loso`는 subject 분리 5-fold(처음 보는 사람), `--mode lodo`는 데이터셋 1개씩 홀드아웃(처음 보는 센서, 배포에 더 정직).
- `train_cnn.py`는 `--device auto|cpu|mps|cuda`(기본 auto=가속기 우선), `--raw-xyz`(원시 3축, LODO 누수 위험), `--epochs` 지원.

## 테스트

```bash
cd ml && ../.venv-ml/bin/python -m unittest test_features -v
```

합성 신호로 창 추출(시프트/패딩)·각 특징의 분석적 성질 검증(7 케이스).
