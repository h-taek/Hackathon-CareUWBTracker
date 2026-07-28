#!/usr/bin/env bash
# NISpike 한 방 실행: 빌드 → 아이폰+워치 설치 → 아이폰 실행 → 콘솔 로그 스트림.
# GUI(Xcode) 없이 CLI로만. Antigravity/VSCode 터미널이나 Run 버튼(tasks.json)에서 호출.
#
# 사용법:
#   ./run.sh                  # 빌드 + 아이폰·워치 설치 + 아이폰 실행 + 로그
#   ./run.sh build            # 빌드만 (컴파일 검증)
#   ./run.sh --list           # 설치 가능한 기기 목록만 출력
#   ./run.sh --device 15      # 이름/모델 부분 일치로 대상 아이폰 지정 (예: 서브폰)
#   ./run.sh --device <UDID>  # UDID로 정확히 지정
#   ./run.sh --no-watch       # 워치 단계 건너뛰기 (서브폰=앵커2 배포엔 워치가 불필요)
#   ./run.sh --watch-only     # 빌드·폰 설치 없이, 마지막 빌드 산출물로 워치만 재설치
#
# 폰이 두 대 이상 페어링돼 있으면 --device 없이는 목록 첫 번째에 설치된다. 메인폰은 USB를 뽑아도
# available(paired)로 목록에 남으므로, 서브폰에 깔 때는 --device를 반드시 쓴다.
#
# 워치앱은 아이폰 앱 번들에 임베드(NISpike.app/Watch/...)돼 함께 빌드된다. companion 자동 전파는
# 느리고 무료 서명이면 불안정하므로, 이 스크립트는 워치에 **직접** 설치한다(devicectl, 즉시 반영).
# 워치 화면에서 Phase 2 → 샘플 시작을 눌러야 송신 시작.
#
# 워치는 USB 포트가 없어 LAN 터널로만 붙는다(transportType: localNetwork). 터널이 끊겨 있으면
# devicectl 이 45초를 버리고 죽으므로, 설치 전에 tunnelState 를 먼저 보고 즉시 안내한다.
set -euo pipefail

SCHEME="NISpike"
WATCH_SCHEME="NISpike Watch App Watch App"
BUNDLE_ID="com.test.NISpike"
WATCH_BUNDLE_ID="com.test.NISpike.watchkitapp"
cd "$(dirname "$0")"   # 프로젝트 디렉터리로 이동(어디서 호출하든 안전)
PROJECT="$PWD/$SCHEME.xcodeproj"   # 안내 문구에 그대로 복붙해도 되도록 절대 경로로 잡아둔다
SELF="$PWD/$(basename "$0")"       # cd 뒤에는 $0(상대경로)이 안 열린다. 사용법을 자기 주석에서 뽑으므로 고정해 둔다

usage() {
  sed -n '5,12p' "$SELF" | sed 's/^# \{0,1\}//'
}

# --- 기기 목록 파싱 -----------------------------------------------------------
# devicectl 표 출력을 "UDID<TAB>상태<TAB>표시이름" 으로 정규화. 상태는 available/unavailable 둘로 접는다
# (connected 도 설치 가능하므로 available 과 같이 취급).
list_devices() {   # $1: iphone | watch
  xcrun devicectl list devices 2>/dev/null | grep -i "$1" | while IFS= read -r line; do
    udid=$(printf '%s' "$line" | grep -oiE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1)
    [[ -n "$udid" ]] || continue
    if [[ "$line" == *unavailable* ]]; then state=unavailable; else state=available; fi
    # 표시이름 = 원본 줄에서 hostname·UDID·상태 컬럼을 걷어낸 나머지(사용자 지정 이름 + 모델)
    name=$(printf '%s' "$line" \
      | sed -E "s/[^ ]*\.coredevice\.local//; s/$udid//; s/available \(paired\)|connecting|connected|unavailable//; s/  +/ /g; s/^ +| +$//g")
    printf '%s\t%s\t%s\n' "$udid" "$state" "$name"
  done
}

# 대상 아이폰 한 대를 "UDID<TAB>표시이름" 으로 확정. 못 고르면 이유를 구분해서 알려주고 실패.
resolve_iphone() {
  local q="$1" rows pool hit
  rows=$(list_devices iphone)
  [[ -n "$rows" ]] || { echo "✗ 아이폰이 목록에 없음. USB 연결/신뢰 확인 후 다시." >&2; return 1; }

  pool=$(printf '%s\n' "$rows" | awk -F'\t' '$2=="available"')

  if [[ -n "$q" ]]; then
    hit=$(printf '%s\n' "$pool" | grep -iF -- "$q" || true)
    if [[ -z "$hit" ]]; then
      if printf '%s\n' "$rows" | awk -F'\t' '$2=="unavailable"' | grep -qiF -- "$q"; then
        echo "✗ '$q' 에 맞는 기기는 있으나 지금 unavailable 입니다." >&2
        echo "  USB 연결 → 폰에서 '신뢰' → 설정 > 개인정보 보호 및 보안 > 개발자 모드 켜기 후 다시." >&2
      else
        echo "✗ '$q' 에 맞는 아이폰 없음. ./run.sh --list 로 확인하세요." >&2
      fi
      return 1
    fi
    if [[ $(printf '%s\n' "$hit" | wc -l | tr -d ' ') -gt 1 ]]; then
      echo "✗ '$q' 가 여러 대에 걸립니다. 더 좁혀서 지정하세요:" >&2
      printf '%s\n' "$hit" | awk -F'\t' '{print "    " $3}' >&2
      return 1
    fi
    pool="$hit"
  fi

  [[ -n "$pool" ]] || { echo "✗ 사용 가능한 아이폰 없음. USB 연결/신뢰 확인 후 다시." >&2; return 1; }
  printf '%s\n' "$pool" | head -1 | awk -F'\t' '{print $1 "\t" $3}'
}

# 워치 한 대를 "UDID<TAB>표시이름" 으로 확정(현재 구성상 워치는 한 대뿐이라 첫 번째를 쓴다).
resolve_watch() {
  local row
  row=$(list_devices watch | awk -F'\t' '$2=="available"' | head -1 || true)
  [[ -n "$row" ]] || { echo "✗ 사용 가능한 워치 없음. 워치를 깨우고 같은 Wi-Fi인지 확인 후 다시." >&2; return 1; }
  printf '%s\n' "$row" | awk -F'\t' '{print $1 "\t" $3}'
}

# 워치 LAN 터널 상태(connected / disconnected / 빈 문자열=조회 불가). 즉답이라 사전 점검용으로 싸다.
watch_tunnel_state() {
  xcrun devicectl device info details --device "$1" 2>/dev/null \
    | awk -F': ' '/tunnelState/{gsub(/[ \t]/,"",$2); print $2; exit}'
}

# 마지막 빌드 산출물(.app) 경로. --watch-only 는 빌드를 안 하므로 DerivedData에서 최신 것을 집는다.
find_last_built_app() {
  local p
  p=$(ls -td "$HOME"/Library/Developer/Xcode/DerivedData/"$SCHEME"-*/Build/Products/*-iphoneos/"$SCHEME".app 2>/dev/null | head -1 || true)
  [[ -n "$p" ]] || return 1
  printf '%s\n' "$p"
}

# 임베드 워치앱을 워치에 직접 설치하고 재실행까지. 터널이 없으면 45초 낭비 대신 즉시 안내하고 1 반환.
install_watch() {   # $1: 워치 UDID, $2: 폰 .app 경로
  local watch_udid="$1" app_path="$2" watch_app tunnel
  watch_app=$(find "$app_path/Watch" -maxdepth 1 -name "*.app" 2>/dev/null | head -1 || true)
  [[ -n "$watch_app" ]] || { echo "  ⚠ 번들에 워치앱이 없음: $app_path/Watch" >&2; return 1; }

  tunnel=$(watch_tunnel_state "$watch_udid")
  if [[ "$tunnel" != "connected" ]]; then
    echo "  ⚠ 워치 터널이 '${tunnel:-조회 불가}' 상태 — 지금은 직접 설치 불가(45초 대기 생략)." >&2
    echo "    1) 워치를 손목에 차고 잠금 해제, 화면 켜두기 (절전이면 Wi-Fi가 끊긴다)" >&2
    echo "    2) 워치 설정 > Wi-Fi 가 맥과 같은 망인지 확인" >&2
    echo "    3) 짝 아이폰도 같은 망에 두고 잠금 해제" >&2
    echo "    → 그래도 안 되면 메인폰에 설치해 companion 전파로 넘기세요(느리지만 터널 불필요)." >&2
    return 1
  fi

  echo "▶ 워치 설치: $(basename "$watch_app")"
  if ! xcrun devicectl device install app --device "$watch_udid" "$watch_app"; then
    # 0xe8008012 = 워치 UDID가 프로파일에 없음. 폰 destination 으로만 빌드하면 워치는 등록되지 않는다.
    echo "  ⚠ 설치 실패. 'provisioning profile cannot be installed' 이면 워치가 프로파일에 없는 것입니다." >&2
    echo "    아래를 한 번 돌려 워치를 등록·서명한 뒤 다시 시도하세요(기기당 1회):" >&2
    # -project 를 붙여야 리포 루트 등 어디에 붙여넣어도 그대로 돈다(스크립트만 cd 하므로).
    echo "      xcodebuild -project '$PROJECT' \\" >&2
    echo "        -scheme '$WATCH_SCHEME' -destination 'id=$watch_udid' \\" >&2
    echo "        -allowProvisioningUpdates -allowProvisioningDeviceRegistration build" >&2
    return 1
  fi
  # 재설치만 하면 실행 중인 워치 앱은 옛 바이너리를 계속 띄운다. 강제 재실행해 새 코드 로드.
  # (--terminate-existing: 켜져 있던 인스턴스 종료 후 새로 시작. 워치 잠금/미착용이면 실패할 수 있어 폴백 안내.)
  echo "▶ 워치 앱 재실행(새 코드 로드)"
  xcrun devicectl device process launch --terminate-existing \
    --device "$watch_udid" "$WATCH_BUNDLE_ID" \
    || echo "  ⚠ 워치 앱 자동 실행 실패 — 워치에서 앱을 직접 종료 후 다시 여세요" >&2
}

# --- 인자 파싱 ---------------------------------------------------------------
MODE=run
DEVICE_QUERY=""
WITH_WATCH=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    build)             MODE=build; shift ;;
    --list|-l)         MODE=list; shift ;;
    --watch-only|-w)   MODE=watch; shift ;;
    --no-watch)        WITH_WATCH=0; shift ;;
    --device|-d)
      DEVICE_QUERY="${2:-}"
      [[ -n "$DEVICE_QUERY" ]] || { echo "✗ --device 뒤에 이름/모델/UDID 일부를 적으세요." >&2; exit 1; }
      shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 echo "✗ 모르는 인자: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ "$MODE" == "watch" && "$WITH_WATCH" == 0 ]]; then
  echo "✗ --watch-only 와 --no-watch 는 같이 못 씁니다." >&2; exit 1
fi
if [[ "$MODE" == "watch" && -n "$DEVICE_QUERY" ]]; then
  echo "  (--device 는 아이폰 지정용이라 --watch-only 에서는 무시됩니다)" >&2
fi

# --- list 모드: 어디에 깔 수 있는지만 보여주고 끝 ---
if [[ "$MODE" == "list" ]]; then
  echo "▶ 아이폰"
  list_devices iphone | awk -F'\t' '{printf "    [%-11s] %s\n           %s\n", $2, $3, $1}' || true
  echo "▶ 워치"
  list_devices watch | awk -F'\t' '{printf "    [%-11s] %s\n           %s\n", $2, $3, $1}' || true
  echo
  echo "지정 예: ./run.sh --device 15        (이름·모델 부분 일치)"
  echo "         ./run.sh --device <UDID>   (정확 지정)"
  exit 0
fi

# --- build-only 모드: 서명 없이 양 타깃 컴파일만 ---
if [[ "$MODE" == "build" ]]; then
  echo "▶ 컴파일만 (iOS+watchOS, 서명 없음)"
  xcodebuild -scheme "$SCHEME" -destination 'generic/platform=iOS' \
    build CODE_SIGNING_ALLOWED=NO | grep -E "error:|warning:|BUILD" || true
  exit 0
fi

# --- watch-only 모드: 빌드·폰 설치 건너뛰고 마지막 산출물로 워치만 재설치 ---
if [[ "$MODE" == "watch" ]]; then
  echo "▶ 워치 탐색"
  WATCH_ROW=$(resolve_watch) || exit 1
  WATCH_UDID=${WATCH_ROW%%$'\t'*}
  echo "  → ${WATCH_ROW#*$'\t'}"
  echo "    $WATCH_UDID"

  echo "▶ 마지막 빌드 산출물 탐색"
  APP_PATH=$(find_last_built_app) \
    || { echo "✗ 빌드 산출물 없음. 먼저 ./run.sh 로 한 번 빌드하세요." >&2; exit 1; }
  echo "  → $APP_PATH"

  install_watch "$WATCH_UDID" "$APP_PATH" || exit 1
  exit 0
fi

# --- 대상 아이폰 확정 ---
# 상태는 connected / available(paired) 둘 다 설치 가능. unavailable(미페어링·미연결)만 제외.
echo "▶ 아이폰 탐색"
IPHONE_ROW=$(resolve_iphone "$DEVICE_QUERY") || exit 1
IPHONE_UDID=${IPHONE_ROW%%$'\t'*}
IPHONE_NAME=${IPHONE_ROW#*$'\t'}
echo "  → $IPHONE_NAME"
echo "    $IPHONE_UDID"
[[ -n "$DEVICE_QUERY" ]] || echo "  (--device 미지정 → 목록 첫 번째. 폰이 여러 대면 ./run.sh --list 로 확인)"

# --- 워치 UDID 자동 탐색 (선택: 없으면 폰만 배포하고 계속) ---
WATCH_UDID=""
if [[ "$WITH_WATCH" == 1 ]]; then
  echo "▶ 워치 탐색"
  WATCH_ROW=$(list_devices watch | awk -F'\t' '$2=="available"' | head -1 || true)
  if [[ -n "$WATCH_ROW" ]]; then
    WATCH_UDID=$(printf '%s' "$WATCH_ROW" | awk -F'\t' '{print $1}')
    echo "  → $(printf '%s' "$WATCH_ROW" | awk -F'\t' '{print $3}')"
  else
    echo "  → (워치 없음, 폰만 배포)"
  fi
else
  echo "▶ 워치 단계 건너뜀 (--no-watch)"
fi

# --- 빌드 산출물(.app) 경로 계산 (기본 DerivedData = iCloud 밖) ---
# xcodebuild -showBuildSettings 는 출력이 전부 캡처돼 화면이 수십 초 조용해진다. 멈춘 걸로 오해하지
# 않도록 들어가기 전에 알리고, 실패하면 stderr 를 그대로 보여준다.
echo "▶ 빌드 설정 조회 (xcodebuild -showBuildSettings, 수십 초 걸릴 수 있음)"
SETTINGS=$(xcodebuild -scheme "$SCHEME" -destination 'generic/platform=iOS' -showBuildSettings) \
  || { echo "✗ 빌드 설정 조회 실패 (위 오류 참고)" >&2; exit 1; }
APP_DIR=$(echo "$SETTINGS" | awk -F' = ' '/ BUILT_PRODUCTS_DIR =/{print $2; exit}')
APP_NAME=$(echo "$SETTINGS" | awk -F' = ' '/ FULL_PRODUCT_NAME =/{print $2; exit}')
APP_PATH="$APP_DIR/$APP_NAME"

# --- 빌드(서명) ---
# -allowProvisioningDeviceRegistration: 처음 보는 기기를 프로파일에 자동 등록. 이게 없으면 새 폰에
# 설치할 때 'provisioning profile cannot be installed on this device' 로 막힌다.
echo "▶ 빌드 + 서명"
xcodebuild -scheme "$SCHEME" -destination "id=$IPHONE_UDID" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build | grep -E "error:|BUILD" || true
[[ -d "$APP_PATH" ]] || { echo "✗ .app 산출물 못 찾음: $APP_PATH" >&2; exit 1; }

# --- 아이폰 설치 ---
echo "▶ 아이폰 설치: $APP_NAME → $IPHONE_NAME"
xcrun devicectl device install app --device "$IPHONE_UDID" "$APP_PATH"

# --- 워치 직접 설치 (임베드 워치앱을 companion 대기 없이 즉시 반영) ---
# 워치 실패는 폰 배포를 막지 않는다. companion 전파라는 폴백이 있으므로 경고만 남기고 계속.
if [[ -n "$WATCH_UDID" ]]; then
  install_watch "$WATCH_UDID" "$APP_PATH" || echo "  ⚠ 워치는 건너뜁니다 (폰 설치는 정상 완료)" >&2
fi

# --- 아이폰 실행 + 콘솔 로그 스트림 (Ctrl-C로 종료) ---
echo "▶ 아이폰 실행 + 로그 스트림 (Ctrl-C 종료)"
xcrun devicectl device process launch --console --device "$IPHONE_UDID" "$BUNDLE_ID"
