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
#
# DB 포트 포워딩 사망 복구(2026-10-10, 보드 cmv223quv): Docker 재시작 뒤 teamspace-postgres 컨테이너는
# 살아났는데 호스트 5433 포워딩이 죽어(TCP 수락 후 즉시 끊김) 앱이 P1001/P1017 → /api/health 503
# {"db":false}. web kickstart 로는 못 고친다. 그래서:
#   - 응답 본문이 "db":false 로 연속 2회(상태 파일 db-fails, web-fails 와 별개)
#   - 컨테이너 안에서는 pg_isready 가 성공(=DB 자체는 정상, 포워딩만 죽음) → docker restart
#   - 컨테이너가 아예 안 떠 있으면 → docker start
#   - 컨테이너는 떠 있는데 pg_isready 실패(복구 중) → 대기
#   - 쿨다운: DB 재시작/기동은 15분에 1번까지(상태 파일 db-restart-at)
#   - DB 조치를 한 사이클엔 web kickstart 를 하지 않는다
# 알림: 셸에서 쓸 수 있는 기존 알림 경로가 없어(슬랙 토큰은 앱 env 에만) 로그만 남긴다.
# launchd PATH 에 docker 가 없을 수 있어 command -v → 알려진 설치 위치 순으로 찾는다.
set -uo pipefail

UID_NUM="$(id -u)"
LOG_PREFIX="[health $(date '+%Y-%m-%dT%H:%M:%S')]"
STATE_DIR="${TEAMSPACE_HEALTH_STATE_DIR:-$HOME/.cache/teamspace-health}"
FAILS_FILE="$STATE_DIR/web-fails"
GRACE_SEC=600
DB_FAILS_FILE="$STATE_DIR/db-fails"
DB_RESTART_FILE="$STATE_DIR/db-restart-at"
DB_COOLDOWN_SEC="${TEAMSPACE_DB_COOLDOWN_SEC:-900}"
PG_CONTAINER="${TEAMSPACE_PG_CONTAINER:-teamspace-postgres}"
HEALTH_URL="${TEAMSPACE_HEALTH_URL:-http://localhost:3002/api/health}"
mkdir -p "$STATE_DIR"

body="$(curl -s -m 20 "$HEALTH_URL" || true)"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$HEALTH_URL" || true)"
code="${code:-000}"

resolve_docker() {
  if [ -n "${TEAMSPACE_DOCKER_BIN:-}" ]; then echo "$TEAMSPACE_DOCKER_BIN"; return; fi
  local d
  d="$(command -v docker 2>/dev/null || true)"
  if [ -n "$d" ]; then echo "$d"; return; fi
  for d in /usr/local/bin/docker /opt/homebrew/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker; do
    if [ -x "$d" ]; then echo "$d"; return; fi
  done
}

# ── DB 복구 (web 판정보다 먼저) ─────────────────────────────────────────────
if echo "$body" | grep -q '"db":false'; then
  db_fails=$(( $(cat "$DB_FAILS_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$db_fails" > "$DB_FAILS_FILE"
  if [ "$db_fails" -ge 2 ]; then
    docker_bin="$(resolve_docker)"
    now="$(date +%s)"
    last="$(cat "$DB_RESTART_FILE" 2>/dev/null || echo 0)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ -z "$docker_bin" ]; then
      echo "$LOG_PREFIX db down (code=$code, db_fails=$db_fails) → docker 를 찾지 못함, 조치 불가"
    elif [ $(( now - last )) -lt "$DB_COOLDOWN_SEC" ]; then
      echo "$LOG_PREFIX db down (code=$code, db_fails=$db_fails) → 쿨다운 중($(( now - last ))s < ${DB_COOLDOWN_SEC}s), 대기"
    else
      running="$("$docker_bin" inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)"
      db_action=""
      if [ "$running" = "true" ]; then
        if "$docker_bin" exec "$PG_CONTAINER" pg_isready -q >/dev/null 2>&1; then
          echo "$LOG_PREFIX db down (code=$code, db_fails=$db_fails) but $PG_CONTAINER ready inside → docker restart $PG_CONTAINER (포트 포워딩 복구)"
          "$docker_bin" restart "$PG_CONTAINER" || true
          db_action=restart
        else
          echo "$LOG_PREFIX db down (code=$code, db_fails=$db_fails), $PG_CONTAINER 기동 중(pg_isready 실패) → 대기"
        fi
      elif [ "$running" = "false" ]; then
        echo "$LOG_PREFIX db down (code=$code, db_fails=$db_fails), $PG_CONTAINER not running → docker start $PG_CONTAINER"
        "$docker_bin" start "$PG_CONTAINER" || true
        db_action=start
      else
        echo "$LOG_PREFIX db down (code=$code, db_fails=$db_fails), $PG_CONTAINER 상태 확인 불가(docker 데몬?) → 대기"
      fi
      if [ -n "$db_action" ]; then
        echo "$now" > "$DB_RESTART_FILE"
        echo 0 > "$DB_FAILS_FILE"
        echo 0 > "$FAILS_FILE"
        # 이번 사이클엔 web 을 건드리지 않는다 — 다음 사이클에 재확인
        exit 0
      fi
    fi
  else
    echo "$LOG_PREFIX db down (code=$code, db_fails=$db_fails) → 다음 사이클 재확인"
  fi
else
  echo 0 > "$DB_FAILS_FILE"
fi

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
