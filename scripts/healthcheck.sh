#!/usr/bin/env bash
# TeamSpace 자가복구 헬스체크 (W7 missed-6) — launchd com.teamspace.health 가 5분마다 실행.
#   /api/health 가 실패(비200)하거나 worker=false 면 해당 launchd 서비스를 kickstart 한다.
set -uo pipefail

UID_NUM="$(id -u)"
LOG_PREFIX="[health $(date '+%Y-%m-%dT%H:%M:%S')]"

body="$(curl -s -m 5 http://localhost:3002/api/health || true)"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:3002/api/health || echo 000)"

if [ "$code" != "200" ]; then
  echo "$LOG_PREFIX web unhealthy (code=$code) → kickstart web"
  launchctl kickstart -k "gui/$UID_NUM/com.teamspace.web" || true
  # web 이 죽었으면 worker 상태 판정 불가 — 다음 사이클에 재확인
  exit 0
fi

if ! echo "$body" | grep -q '"worker":true'; then
  echo "$LOG_PREFIX worker stale ($body) → kickstart worker"
  launchctl kickstart -k "gui/$UID_NUM/com.teamspace.worker" || true
else
  echo "$LOG_PREFIX ok"
fi
