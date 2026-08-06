#!/usr/bin/env bash
# 코드 제출용 압축본을 만든다. 저장소를 그대로 압축하지 않는 이유는 셋이다.
#
#   1. 심사 대상이 아닌 것을 뺀다      — 아래 제외 목록
#   2. 실행 스크립트를 제출본에 맞춘다  — 없는 test/를 가리키는 스크립트가 남으면 오류가 난다
#   3. 산출물이 재현 가능해야 한다      — 손으로 고르면 매번 구성이 달라진다
#
# 심사는 **완성품의 동작**을 보는 것이지 개발 과정을 보는 것이 아니다. 그래서 정적 테스트
# (test/)와 모델 학습 파이프라인(ml/)을 뺀다. 학습이 끝난 모델 자체는 런타임이 읽으므로
# `server/detection/model-lgbm.json`으로 남는다 — 낙상 판정은 그대로 동작한다.
#
# **문서는 루트 README.md와 프로젝트_기획안.md 둘뿐이다.** 폴더별 문서는 넣지 않는다.
#
# 사용법:
#   tools/make-submission.sh [출력경로.zip] [--name <풀었을 때 나올 폴더명>]
#
# 기본 출력은 저장소 밖의 `../<기본이름>-submission.zip`이다. 저장소 안에 만들면
# 다음번 압축에 자기 자신이 딸려 들어간다.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
DEFAULT_NAME="FrameWorkOn-fall-monitoring"

OUT=""
NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    -*) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
    *)  OUT="$1"; shift ;;
  esac
done

OUT="${OUT:-$ROOT/../$DEFAULT_NAME-submission.zip}"

# 풀었을 때 나올 폴더 이름. 안 주면 압축 파일 이름을 따른다 — 파일과 폴더가 어긋나면
# 받는 쪽이 어느 쪽이 프로젝트 이름인지 알 수 없다.
# **저장소 디렉터리 이름(08_Hackathon)은 쓰지 않는다** — 내부 작업명이라 받는 사람에게 뜻이 없다.
if [ -z "$NAME" ]; then
  NAME="$(basename "$OUT")"
  NAME="${NAME%.zip}"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# 압축을 풀면 이 이름의 디렉터리 하나가 나오게 한다. 현재 위치에 파일이 쏟아지지 않는다.
PKG="$STAGE/$NAME"
mkdir -p "$PKG"

# .gitignore를 그대로 따르므로 node_modules·server/data·.env·HANDOFF.md 등은
# 자동으로 빠진다. 아래는 추적되지만 제출하지 않는 것들이다.
rsync -a \
  --filter=':- .gitignore' \
  --exclude='.git/' \
  --exclude='docs/' \
  --exclude='test/' \
  --exclude='ml/' \
  --exclude='.vscode/' \
  --exclude='pdf-forge-exports/' \
  --exclude='.gitignore' \
  --exclude='tools/make-submission.sh' \
  --exclude='server/public/README.md' \
  --exclude='server/public/_ds/readme.md' \
  "$ROOT/" "$PKG/"

# tools/에는 README가 실제로 쓰는 수신 목업 하나만 남긴다. 나머지(ingest 생성·재생·평가
# 하네스)는 개발 도구이고, 그 사용법이 제외된 ml/의 데이터셋을 인자로 받는 형태라
# 제출본에서는 돌지 않는다.
find "$PKG/tools" -mindepth 1 -maxdepth 1 ! -name 'export-sink.ts' -exec rm -rf {} +

# 제출본에는 test/가 없다. 그것을 가리키는 스크립트와 설정을 같이 정리한다.
# 정적 검사(test·typecheck)가 빠지면 개발 의존성이 쓰일 자리가 없어지므로,
# `npm install` 없이 곧바로 실행된다는 README의 안내와 구성이 일치하게 된다.
# 조립 도구는 제출본 밖(임시 디렉터리)에 둔다. 확장자 .cjs는 제출본 package.json의
# "type": "module" 선언에 걸리지 않게 하기 위한 것이다.
cat > "$STAGE/adjust.cjs" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const pkgDir = process.argv[2];

const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
delete manifest.scripts;          // test·typecheck 뿐이고 둘 다 제출본에 없다
delete manifest.devDependencies;  // 정적 검사가 빠지면 쓸 자리가 없다
fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');

// tsconfig는 남긴다 — 런타임이 읽지는 않지만 module·target 선언이 프로젝트 설정이다.
// include에서 없는 디렉터리만 걷어낸다.
const tsconfigPath = path.join(pkgDir, 'tsconfig.json');
// 앞의 쉼표까지 같이 걷어낸다. 항목만 지우면 `[…, ]`가 남는다.
const tsconfig = fs.readFileSync(tsconfigPath, 'utf8')
  .replace(/,\s*"test\/\*\*\/\*\.ts"/, '');
if (tsconfig.includes('test/**')) throw new Error('tsconfig에서 test 경로를 못 걷어냈다');
fs.writeFileSync(tsconfigPath, tsconfig);

// 의존성이 없으므로 잠금 파일은 가리킬 대상이 없다.
fs.rmSync(path.join(pkgDir, 'package-lock.json'), { force: true });
NODE
node "$STAGE/adjust.cjs" "$PKG"

# 실행에 필요한 것이 실제로 들어갔는지 본다. 하나라도 없으면 받은 사람이 못 띄운다.
for required in README.md 프로젝트_기획안.md setup.sh server/.env.example package.json server/server.ts server/map.json \
                server/detection/model-lgbm.json server/public/index.html \
                tools/export-sink.ts; do
  [ -e "$PKG/$required" ] || { echo "빠졌다: $required" >&2; exit 1; }
done

# 빠져야 할 것이 남았는지 본다.
for forbidden in docs test ml server/.env HANDOFF.md node_modules server/data .git \
                 tools/cli.ts tools/README.md tools/recon server/README.md \
                 server/public/README.md server/public/_ds/readme.md; do
  [ ! -e "$PKG/$forbidden" ] || { echo "들어가면 안 된다: $forbidden" >&2; exit 1; }
done

rm -f "$OUT"
( cd "$STAGE" && zip -qr "$OUT" "$NAME" -x '*/.DS_Store' )

printf '압축본: %s\n' "$OUT"
printf '크기:   %s\n' "$(du -h "$OUT" | cut -f1)"
printf '파일:   %s개\n' "$(find "$PKG" -type f | wc -l | tr -d ' ')"
