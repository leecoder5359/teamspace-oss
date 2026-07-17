#!/usr/bin/env bash
# TeamSpace 로컬 배포 — ⚠️ macOS(launchd) 전용 스크립트.
#   launchd LaunchAgent 로 상시 구동한다(다른 OS 는 systemd 등으로 별도 구성 필요).
#   1) prod 빌드  2) launchd plist 생성·설치(web·worker·backup·health)  3) (재)기동
# plist 는 scripts/launchd/templates/*.plist.tmpl 에서 이 머신의 실경로를 치환해 생성한다.
# 재배포도 같은 명령: pnpm deploy:local
set -euo pipefail

[ "$(uname)" = "Darwin" ] || { echo "이 스크립트는 macOS(launchd) 전용입니다."; exit 1; }

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMPL_DIR="$REPO_DIR/scripts/launchd/templates"
PLIST_DST="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/teamspace"
UID_NUM="$(id -u)"

# 템플릿 치환용 실값 감지
command -v node >/dev/null 2>&1 || { echo "node 를 찾을 수 없습니다"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm 을 찾을 수 없습니다"; exit 1; }
NODE_BIN_DIR="$(dirname "$(command -v node)")"
PNPM="$(command -v pnpm)"

mkdir -p "$PLIST_DST" "$LOG_DIR"

echo "→ prod 빌드"
cd "$REPO_DIR"
pnpm exec next build

echo "→ launchd plist 생성·설치 (REPO_DIR=$REPO_DIR, NODE_BIN_DIR=$NODE_BIN_DIR, PNPM=$PNPM)"
for name in web worker backup health; do
  label="com.teamspace.$name"
  sed -e "s|__REPO_DIR__|$REPO_DIR|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
      -e "s|__PNPM__|$PNPM|g" \
      "$TMPL_DIR/$label.plist.tmpl" > "$PLIST_DST/$label.plist"
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  # bootout 직후 bootstrap 은 간헐적 I/O error — 재시도하고, 실패해도 다음 서비스로 진행
  launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST/$label.plist" 2>/dev/null ||
    { sleep 4; launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST/$label.plist"; } ||
    echo "⚠️ $label bootstrap 실패 — 수동 확인 필요"
done

echo "→ 기동 확인"
sleep 3
launchctl list | grep com.teamspace || true
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://localhost:3002/login || true)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "web: http://localhost:3002 → $code"
echo "완료. 로그: $LOG_DIR"
