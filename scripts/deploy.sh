#!/usr/bin/env bash
# TeamSpace 맥미니 로컬 배포 (확정안 A: launchd 상시 구동 + tailscale serve).
#   1) prod 빌드  2) launchd plist 설치(web·worker·backup)  3) (재)기동
# 재배포도 같은 명령: pnpm deploy:local
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$REPO_DIR/scripts/launchd"
PLIST_DST="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/teamspace"
UID_NUM="$(id -u)"

mkdir -p "$PLIST_DST" "$LOG_DIR"

echo "→ prod 빌드"
cd "$REPO_DIR"
pnpm exec next build

echo "→ launchd plist 설치"
# 템플릿(scripts/launchd/templates/*.plist.tmpl)이 있으면 이 머신의 실경로를 치환해 설치하고,
# 없으면(사전 렌더된 실물 plist 를 두는 배포) 그대로 복사한다.
TMPL_DIR="$PLIST_SRC/templates"
NODE_BIN_DIR="$(dirname "$(command -v node)")"
PNPM_BIN="$(command -v pnpm)"
for name in web worker backup health; do
  label="com.teamspace.$name"
  if [ -f "$TMPL_DIR/$label.plist.tmpl" ]; then
    sed -e "s|__REPO_DIR__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" \
        -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" -e "s|__PNPM__|$PNPM_BIN|g" \
      "$TMPL_DIR/$label.plist.tmpl" > "$PLIST_DST/$label.plist"
  else
    cp "$PLIST_SRC/$label.plist" "$PLIST_DST/$label.plist"
  fi
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
