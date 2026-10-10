#!/usr/bin/env bash
# TeamSpace 자가복구 헬스체크 (W7 missed-6) — launchd com.teamspace.health 가 5분마다 실행.
#   /api/health 가 실패(비200)하거나 worker=false 면 해당 launchd 서비스를 kickstart 한다.
#
# 부하 오탐 방지(2026-10-09): 다른 세션의 대량 테스트로 load 가 200+ 일 때 응답이 5초를 넘겨
# 매 사이클 web 을 죽였고, 막 뜬 web 을 다음 사이클에 또 죽이는 재시작 고리가 생겼다.
#   - 응답 대기 20초
#   - 연속 2회 실패해야 재시작(상태 파일)
#   - web 프로세스가 뜬 지 10분이 안 됐으면 재시작하지 않는다(기동 유예)
#   - web 프로세스가 아예 없으면(크래시) 유예 없이 재시작. 기동 중(포트 미개방)이어도 유예 안이면 기다린다
set -uo pipefail

UID_NUM="$(id -u)"
LOG_PREFIX="[health $(date '+%Y-%m-%dT%H:%M:%S')]"
STATE_DIR="${TEAMSPACE_HEALTH_STATE_DIR:-$HOME/.cache/teamspace-health}"
FAILS_FILE="$STATE_DIR/web-fails"
GRACE_SEC=600
mkdir -p "$STATE_DIR"

body="$(curl -s -m 20 http://localhost:3002/api/health || true)"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 http://localhost:3002/api/health || true)"
code="${code:-000}"

web_pid="$(launchctl list 2>/dev/null | awk '$3=="com.teamspace.web"{print $1}')"
listening=0
/usr/sbin/lsof -nP -iTCP:3002 -sTCP:LISTEN >/dev/null 2>&1 && listening=1

if [ "$code" != "200" ]; then
  fails=$(( $(cat "$FAILS_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$FAILS_FILE"
  age=0
  if [ -n "$web_pid" ] && [ "$web_pid" != "-" ]; then
    # etime → 초 ([[dd-]hh:]mm:ss)
    age="$(ps -o etime= -p "$web_pid" 2>/dev/null | awk '{n=split($1,a,/[-:]/); s=0; m=1; for(i=n;i>=1;i--){ if(i==n) s+=a[i]; else if(i==n-1) s+=a[i]*60; else if(i==n-2) s+=a[i]*3600; else s+=a[i]*86400 } print s}')"
    age="${age:-0}"
  fi
  load="$(/usr/sbin/sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"
  alive=0
  [ -n "$web_pid" ] && [ "$web_pid" != "-" ] && alive=1
  if [ "$alive" = "1" ] && { [ "$fails" -lt 2 ] || [ "$age" -lt "$GRACE_SEC" ]; }; then
    echo "$LOG_PREFIX web slow (code=$code, fails=$fails, age=${age}s, listening=$listening, load=$load) → 대기"
    exit 0
  fi
  echo "$LOG_PREFIX web unhealthy (code=$code, fails=$fails, age=${age}s, listening=$listening, load=$load) → kickstart web"
  echo 0 > "$FAILS_FILE"
  launchctl kickstart -k "gui/$UID_NUM/com.teamspace.web" || true
  # web 이 죽었으면 worker 상태 판정 불가 — 다음 사이클에 재확인
  exit 0
fi
echo 0 > "$FAILS_FILE"

if ! echo "$body" | grep -q '"worker":true'; then
  echo "$LOG_PREFIX worker stale ($body) → kickstart worker"
  launchctl kickstart -k "gui/$UID_NUM/com.teamspace.worker" || true
else
  echo "$LOG_PREFIX ok"
fi
