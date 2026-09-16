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
# bootout 은 비동기다 — 명령이 돌아와도 서비스가 아직 내려가는 중이면 bootstrap 이
# "Bootstrap failed: 5: Input/output error" 로 실패한다. 워커는 폴링 루프를 끝내느라 특히 늦어서
# 고정 4초 재시도 1번으로는 매 배포 실패했다(2026-09-14 두 번 연속). 그래서
#   ① 서비스가 launchd 에서 실제로 사라질 때까지(최대 30초) 기다리고
#   ② bootstrap 을 간격을 늘려 가며 최대 5번 시도한다.
reload_service() {
  local label="$1" target="gui/$UID_NUM/$1"
  launchctl bootout "$target" 2>/dev/null || true
  for _ in $(seq 1 30); do
    launchctl print "$target" >/dev/null 2>&1 || break
    sleep 1
  done
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST/$label.plist" 2>/dev/null; then
      [ "$attempt" -gt 1 ] && echo "  $label bootstrap 성공(${attempt}번째 시도)"
      return 0
    fi
    sleep $((attempt * 2))
  done
  echo "⚠️ $label bootstrap 실패(5회) — 수동 확인 필요: launchctl bootstrap gui/$UID_NUM $PLIST_DST/$label.plist"
  return 0
}

for name in web worker backup health; do
  label="com.teamspace.$name"
  if [ -f "$TMPL_DIR/$label.plist.tmpl" ]; then
    sed -e "s|__REPO_DIR__|$REPO_DIR|g" -e "s|__HOME__|$HOME|g" \
        -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" -e "s|__PNPM__|$PNPM_BIN|g" \
      "$TMPL_DIR/$label.plist.tmpl" > "$PLIST_DST/$label.plist"
  else
    cp "$PLIST_SRC/$label.plist" "$PLIST_DST/$label.plist"
  fi
  reload_service "$label"
done

echo "→ 기동 확인"
sleep 3
launchctl list | grep com.teamspace || true
for name in web worker backup health; do
  launchctl print "gui/$UID_NUM/com.teamspace.$name" >/dev/null 2>&1 || echo "⚠️ com.teamspace.$name 가 launchd 에 없습니다"
done
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://localhost:3002/login || true)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "web: http://localhost:3002 → $code"
echo "완료. 로그: $LOG_DIR"
