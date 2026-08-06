#!/usr/bin/env bash
# 의존성 설치·점검. macOS 기준이다.
#
# 서버 자체는 Node.js 하나만 있으면 돌고 외부 패키지를 쓰지 않는다. 3D 재구성만 외부
# 도구가 필요하며, 그 도구가 없어도 나머지 기능은 전부 동작한다. 그래서 필수와 선택을
# 나눠 처리한다.
#
#   ./setup.sh                기본. 필수를 점검하고, 없으면 물어본 뒤 설치한다
#   ./setup.sh --check        아무것도 설치하지 않고 상태만 본다
#   ./setup.sh --with-recon   3D 재구성 도구까지 함께 처리한다
#   ./setup.sh --yes          확인 없이 진행한다
#
# 여러 번 실행해도 된다. 이미 갖춰진 것은 건너뛴다.
set -euo pipefail

cd "$(dirname "$0")"

NODE_MIN_MAJOR=22
NODE_MIN_MINOR=18
COLMAP_MAJOR=4
OPENSPLAT_DIR="tools/recon/OpenSplat"
OPENSPLAT_BIN="$OPENSPLAT_DIR/build/opensplat"

CHECK_ONLY=0
WITH_RECON=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --check)      CHECK_ONLY=1 ;;
    --with-recon) WITH_RECON=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    # 사용법은 이 파일 첫머리 주석이 정본이다. 두 벌로 두면 어긋난다.
    # 줄 번호로 자르지 않는다 — 주석이 늘면 조용히 어긋난다. 주석이 끝나는 데서 멈춘다.
    --help|-h)    awk 'NR>1 && !/^#/ { exit } NR>1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "알 수 없는 인자: $arg (--help로 사용법을 본다)" >&2; exit 2 ;;
  esac
done

BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
ok()   { printf '  ✓ %s\n' "$1"; }
miss() { printf '  ✗ %s\n' "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
head_() { printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"; }

MISSING_REQUIRED=0
MISSING_OPTIONAL=0

# 설치가 필요할 때만 물어본다. --check면 절대 설치하지 않는다.
confirm() {
  [ "$CHECK_ONLY" = 1 ] && return 1
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '    → %s 설치할까? [y/N] ' "$1"
  read -r reply </dev/tty || return 1
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ── 전제 ────────────────────────────────────────────────────────────────
head_ "전제"

if [ "$(uname -s)" != "Darwin" ]; then
  miss "macOS가 아니다 (uname: $(uname -s))"
  note "이 스크립트는 macOS 기준이다. 다른 환경은 README 1장을 직접 따른다."
  exit 1
fi
ok "macOS $(sw_vers -productVersion) ($(uname -m))"

HAS_BREW=0
if command -v brew >/dev/null 2>&1; then
  HAS_BREW=1
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
else
  miss "Homebrew 없음"
  note "https://brew.sh 의 설치 명령을 먼저 실행한다. 이 스크립트는 brew로 설치한다."
fi

# ── 필수: Node.js ───────────────────────────────────────────────────────
head_ "필수 — 서버 실행"

# `.ts`를 빌드 없이 직접 실행하는 구조라, 타입 스트리핑이 기본 활성화된 22.18이 하한이다.
node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node --version 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"; minor="$(printf '%s' "$v" | cut -d. -f2)"
  [ "$major" -gt "$NODE_MIN_MAJOR" ] && return 0
  [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]
}

if node_version_ok; then
  ok "Node.js $(node --version)"
else
  if command -v node >/dev/null 2>&1; then
    miss "Node.js $(node --version) — ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} 이상이 필요하다"
    note "낮은 버전에서는 ERR_UNKNOWN_FILE_EXTENSION으로 서버가 기동하지 않는다."
  else
    miss "Node.js 없음"
  fi
  if [ "$HAS_BREW" = 1 ] && confirm "node를"; then
    brew install node
    node_version_ok && ok "Node.js $(node --version)" || {
      miss "설치 후에도 버전이 낮다"
      note "brew link --overwrite node 로 경로를 정리하거나 nodejs.org LTS를 쓴다."
      MISSING_REQUIRED=$((MISSING_REQUIRED + 1))
    }
  else
    MISSING_REQUIRED=$((MISSING_REQUIRED + 1))
  fi
fi

# ── 선택: 3D 재구성 ─────────────────────────────────────────────────────
head_ "선택 — 3D 재구성 (없어도 나머지 기능은 전부 동작한다)"

if [ "$WITH_RECON" = 0 ] && [ "$CHECK_ONLY" = 0 ]; then
  note "설치하려면 --with-recon 을 붙인다. 아래는 현재 상태만 본 것이다."
fi

# 설치 대상인지, 상태만 볼 것인지.
recon_install() { [ "$WITH_RECON" = 1 ] && [ "$CHECK_ONLY" = 0 ] && [ "$HAS_BREW" = 1 ]; }

# ffmpeg · ffprobe — 영상에서 프레임을 뽑는다.
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"
else
  miss "ffmpeg / ffprobe 없음"
  MISSING_OPTIONAL=$((MISSING_OPTIONAL + 1))
  if recon_install && confirm "ffmpeg를"; then brew install ffmpeg && ok "ffmpeg 설치됨"; fi
fi

# COLMAP — 카메라 자세를 푼다. 4.x여야 한다.
if command -v colmap >/dev/null 2>&1; then
  COLMAP_VER="$(colmap --help 2>&1 | head -1 | awk '{print $2}')"
  if [ "${COLMAP_VER%%.*}" = "$COLMAP_MAJOR" ]; then
    ok "COLMAP $COLMAP_VER"
  else
    miss "COLMAP $COLMAP_VER — ${COLMAP_MAJOR}.x가 필요하다"
    note "4.x에서 GPU 옵션 이름이 바뀌어(--FeatureExtraction.use_gpu) 3.x는 첫 단계에서 멈춘다."
    MISSING_OPTIONAL=$((MISSING_OPTIONAL + 1))
  fi
else
  miss "COLMAP 없음"
  MISSING_OPTIONAL=$((MISSING_OPTIONAL + 1))
  if recon_install && confirm "colmap을"; then brew install colmap && ok "COLMAP 설치됨"; fi
fi

# OpenSplat — 3DGS를 학습한다. 배포본이 없어 직접 빌드한다.
if [ -x "$OPENSPLAT_BIN" ]; then
  ok "OpenSplat ($OPENSPLAT_BIN)"
else
  miss "OpenSplat 없음"
  note "AGPLv3이고 산출물이 이 기기 전용이라 동봉하지 않는다. 아래에서 직접 빌드한다."
  MISSING_OPTIONAL=$((MISSING_OPTIONAL + 1))

  if recon_install && confirm "OpenSplat을 빌드해서"; then
    # Metal 툴체인은 Xcode에 기본 포함되지 않는다. 없으면 빌드가 중간에 멈춘다.
    if ! xcrun --find metal >/dev/null 2>&1; then
      note "Metal 툴체인을 받는다 (xcodebuild -downloadComponent MetalToolchain)"
      xcodebuild -downloadComponent MetalToolchain
    fi

    # **OpenCV는 4를 써야 한다.** 5는 calib3d 모듈이 재편되어 링크가 실패한다.
    brew install cmake pytorch opencv@4

    [ -d "$OPENSPLAT_DIR" ] || git clone https://github.com/pierotofy/OpenSplat.git "$OPENSPLAT_DIR"

    # 경로를 박아 넣지 않는다 — brew 위치는 기기마다 다르다(Intel은 /usr/local).
    mkdir -p "$OPENSPLAT_DIR/build"
    ( cd "$OPENSPLAT_DIR/build"
      cmake -DCMAKE_PREFIX_PATH="$(brew --prefix pytorch);$(brew --prefix opencv@4)" \
            -DOpenCV_DIR="$(brew --prefix opencv@4)/lib/cmake/opencv4" \
            -DGPU_RUNTIME=MPS ..
      # 파이프로 넘기지 않는다 — `make | tail`은 tail의 종료 코드를 돌려줘 실패가 성공으로 보인다.
      make -j"$(sysctl -n hw.logicalcpu)" )

    [ -x "$OPENSPLAT_BIN" ] && ok "OpenSplat 빌드 완료" || miss "빌드 실패 — 위 로그를 확인한다"
  fi
fi

# ── 결과 ────────────────────────────────────────────────────────────────
head_ "결과"

if [ "$MISSING_REQUIRED" -gt 0 ]; then
  miss "필수 항목이 갖춰지지 않아 서버를 띄울 수 없다."
  exit 1
fi

ok "서버를 띄울 수 있다."
if [ "$MISSING_OPTIONAL" -gt 0 ]; then
  note "3D 재구성 도구 ${MISSING_OPTIONAL}개가 없다. 영상 업로드와 3D 조회는 되고 변환만 자동으로 걸지 않는다."
  note "이미 만들어진 .ply를 올려 3D 화면을 확인하는 방법은 README 3.6절에 있다."
fi

cat <<'NEXT'

  다음 —
    node server/server.ts --main-anchor-id phoneMain --sub-anchor-id phoneSub \
      --anchor-distance 4 --half-plane positive

    브라우저에서 http://localhost:8080
    설정을 바꾸려면 cp server/.env.example server/.env
NEXT
