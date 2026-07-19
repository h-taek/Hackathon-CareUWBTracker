#!/usr/bin/env bash
# NISpike 한 방 실행: 빌드 → 아이폰+워치 설치 → 아이폰 실행 → 콘솔 로그 스트림.
# GUI(Xcode) 없이 CLI로만. Antigravity/VSCode 터미널이나 Run 버튼(tasks.json)에서 호출.
#
# 사용법:
#   ./run.sh            # 빌드 + 아이폰·워치 설치 + 아이폰 실행 + 로그
#   ./run.sh build      # 빌드만 (컴파일 검증)
#
# 워치앱은 아이폰 앱 번들에 임베드(NISpike.app/Watch/...)돼 함께 빌드된다. companion 자동 전파는
# 느리고 무료 서명이면 불안정하므로, 이 스크립트는 워치에 **직접** 설치한다(devicectl, 즉시 반영).
# 워치 화면에서 Phase 2 → 샘플 시작을 눌러야 송신 시작.
set -euo pipefail

SCHEME="NISpike"
BUNDLE_ID="com.test.NISpike"
cd "$(dirname "$0")"   # 프로젝트 디렉터리로 이동(어디서 호출하든 안전)

# --- build-only 모드: 서명 없이 양 타깃 컴파일만 ---
if [[ "${1:-}" == "build" ]]; then
  echo "▶ 컴파일만 (iOS+watchOS, 서명 없음)"
  xcodebuild -scheme "$SCHEME" -destination 'generic/platform=iOS' \
    build CODE_SIGNING_ALLOWED=NO | grep -E "error:|warning:|BUILD" || true
  exit 0
fi

# --- 사용 가능한 아이폰 UDID 자동 탐색 ---
# 상태는 connected / available(paired) 둘 다 설치 가능. unavailable(미페어링·타인기기)만 제외.
echo "▶ 아이폰 탐색"
IPHONE_UDID=$(xcrun devicectl list devices 2>/dev/null \
  | grep -i iphone | grep -vi unavailable \
  | grep -oiE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' \
  | head -1 || true)
if [[ -z "$IPHONE_UDID" ]]; then
  echo "✗ 사용 가능한 아이폰 없음. USB 연결/신뢰 확인 후 다시." >&2
  exit 1
fi
echo "  → $IPHONE_UDID"

# --- 워치 UDID 자동 탐색 (선택: 없으면 폰만 배포하고 계속) ---
echo "▶ 워치 탐색"
WATCH_UDID=$(xcrun devicectl list devices 2>/dev/null \
  | grep -i watch | grep -vi unavailable \
  | grep -oiE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' \
  | head -1 || true)
[[ -n "$WATCH_UDID" ]] && echo "  → $WATCH_UDID" || echo "  → (워치 없음, 폰만 배포)"

# --- 빌드 산출물(.app) 경로 계산 (기본 DerivedData = iCloud 밖) ---
SETTINGS=$(xcodebuild -scheme "$SCHEME" -destination 'generic/platform=iOS' -showBuildSettings 2>/dev/null)
APP_DIR=$(echo "$SETTINGS" | awk -F' = ' '/ BUILT_PRODUCTS_DIR =/{print $2; exit}')
APP_NAME=$(echo "$SETTINGS" | awk -F' = ' '/ FULL_PRODUCT_NAME =/{print $2; exit}')
APP_PATH="$APP_DIR/$APP_NAME"

# --- 빌드(서명) ---
echo "▶ 빌드 + 서명"
xcodebuild -scheme "$SCHEME" -destination "id=$IPHONE_UDID" \
  -allowProvisioningUpdates build | grep -E "error:|BUILD" || true
[[ -d "$APP_PATH" ]] || { echo "✗ .app 산출물 못 찾음: $APP_PATH" >&2; exit 1; }

# --- 아이폰 설치 ---
echo "▶ 아이폰 설치: $APP_NAME"
xcrun devicectl device install app --device "$IPHONE_UDID" "$APP_PATH"

# --- 워치 직접 설치 (임베드 워치앱을 companion 대기 없이 즉시 반영) ---
if [[ -n "$WATCH_UDID" ]]; then
  WATCH_APP=$(find "$APP_PATH/Watch" -maxdepth 1 -name "*.app" 2>/dev/null | head -1 || true)
  if [[ -n "$WATCH_APP" ]]; then
    echo "▶ 워치 설치: $(basename "$WATCH_APP")"
    xcrun devicectl device install app --device "$WATCH_UDID" "$WATCH_APP" \
      || echo "  ⚠ 워치 설치 실패(터널 유휴 등) — 폰 companion 전파로 폴백" >&2
    # 재설치만 하면 실행 중인 워치 앱은 옛 바이너리를 계속 띄운다. 강제 재실행해 새 코드 로드.
    # (--terminate-existing: 켜져 있던 인스턴스 종료 후 새로 시작. 워치 잠금/미착용이면 실패할 수 있어 폴백 안내.)
    echo "▶ 워치 앱 재실행(새 코드 로드)"
    xcrun devicectl device process launch --terminate-existing \
      --device "$WATCH_UDID" com.test.NISpike.watchkitapp \
      || echo "  ⚠ 워치 앱 자동 실행 실패 — 워치에서 앱을 직접 종료 후 다시 여세요" >&2
  fi
fi

# --- 아이폰 실행 + 콘솔 로그 스트림 (Ctrl-C로 종료) ---
echo "▶ 아이폰 실행 + 로그 스트림 (Ctrl-C 종료)"
xcrun devicectl device process launch --console --device "$IPHONE_UDID" "$BUNDLE_ID"
