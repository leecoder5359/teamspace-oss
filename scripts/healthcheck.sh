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
#
# 공개 주소 외부 감시(2026-10-16): 공개 주소는 엣지 VM(Caddy) → Tailscale → 이 머신으로 중계된다. 그 구간이
# 끊기면 로컬 /api/health 는 멀쩡해서 아무도 몰랐다. 그래서:
#   - 로컬이 200 일 때만 $PUBLIC_BASE_URL/login 을 GET(제한 TEAMSPACE_PUBLIC_TIMEOUT_SEC, 기본 15초)
#   - 비200 이 연속 2회(상태 파일 public-fails)면 "로컬 정상·공개 실패 → 엣지/중계 문제" 슬랙 알림
#   - 로컬이 확정 비정상이라 web 을 kickstart 할 때는 "로컬 다운" 알림(공개 실패는 로컬 탓이므로 엣지 알림 안 함)
#   - 같은 종류 알림은 TEAMSPACE_ALERT_COOLDOWN_SEC(기본 1시간)에 1번, 복구되면 복구 알림 1번
#   - 인증서 만료는 따로 보지 않는다: 만료·검증 실패면 curl 이 실패(000)해 위 공개 실패 알림으로 잡힌다
# 공개 주소·슬랙 값은 환경변수 → 레포의 Next env 파일(.env.production.local → .env.local → .env.production → .env)
# 순으로 찾는다(launchd 는 앱 env 를 넘겨주지 않는다). 호스트·채널을 스크립트에 박지 않는다.
#   PUBLIC_BASE_URL                  없으면 공개 감시를 건너뛴다
#   AUTH_SLACK_BOT_TOKEN             앱과 같은 봇 토큰
#   TEAMSPACE_HEALTH_SLACK_CHANNEL   알림 채널(없으면 AUTH_SLACK_DEFAULT_CHANNEL). 둘 다 없으면 로그만 남긴다
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
PUBLIC_FAILS_FILE="$STATE_DIR/public-fails"
ALERT_COOLDOWN_SEC="${TEAMSPACE_ALERT_COOLDOWN_SEC:-3600}"
PUBLIC_TIMEOUT_SEC="${TEAMSPACE_PUBLIC_TIMEOUT_SEC:-15}"
REPO_DIR="${TEAMSPACE_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
mkdir -p "$STATE_DIR"

# 환경변수 우선, 없으면 Next 가 읽는 env 파일에서 KEY= 줄을 읽는다(source 하지 않음 — 파일 내용을 실행하지 않는다).
env_get() {
  local key="$1" v f line
  v="${!key:-}"
  if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  for f in .env.production.local .env.local .env.production .env; do
    [ -f "$REPO_DIR/$f" ] || continue
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$REPO_DIR/$f" 2>/dev/null | tail -n1)"
    [ -n "$line" ] || continue
    v="${line#*=}"
    case "$v" in
      \"*\") v="${v#\"}"; v="${v%\"}" ;;
      \'*\') v="${v#\'}"; v="${v%\'}" ;;
      *) v="${v%%[[:space:]]#*}"; v="$(printf '%s' "$v" | sed -E 's/[[:space:]]+$//')" ;;
    esac
    if [ -n "$v" ]; then printf '%s' "$v"; return; fi
  done
}

# 슬랙 발송. 토큰/채널이 없으면 로그만. 토큰은 argv(ps 에 보임) 대신 stdin 헤더로 넘긴다.
slack_notify() {
  local text="$1" token channel esc
  token="$(env_get AUTH_SLACK_BOT_TOKEN)"
  channel="$(env_get TEAMSPACE_HEALTH_SLACK_CHANNEL)"
  [ -n "$channel" ] || channel="$(env_get AUTH_SLACK_DEFAULT_CHANNEL)"
  if [ -z "$token" ] || [ -z "$channel" ]; then
    echo "$LOG_PREFIX (슬랙 미설정 — 알림 생략) $text"
    return 0
  fi
  esc="$(printf '%s' "$text" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  printf 'Authorization: Bearer %s\n' "$token" | curl -s -m 10 -o /dev/null -X POST \
    -H @- -H 'Content-Type: application/json; charset=utf-8' \
    --data "{\"channel\":\"$channel\",\"text\":\"$esc\"}" \
    https://slack.com/api/chat.postMessage || echo "$LOG_PREFIX 슬랙 발송 실패"
  echo "$LOG_PREFIX 알림 발송: $text"
}

# 종류별(edge|local) 알림 — 쿨다운 안이면 생략. 마지막 알림 시각은 상태 파일 alert-<kind>-at.
alert() {
  local kind="$1" text="$2" now last f="$STATE_DIR/alert-$1-at"
  now="$(date +%s)"
  last="$(cat "$f" 2>/dev/null || echo 0)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $(( now - last )) -lt "$ALERT_COOLDOWN_SEC" ]; then
    echo "$LOG_PREFIX 알림 쿨다운 중($kind, $(( now - last ))s < ${ALERT_COOLDOWN_SEC}s)"
    return 0
  fi
  echo "$now" > "$f"
  slack_notify "$text"
}

# 알림을 보냈던 종류가 정상으로 돌아오면 복구 알림 1번.
resolve_alert() {
  local f="$STATE_DIR/alert-$1-at"
  [ -f "$f" ] || return 0
  rm -f "$f"
  slack_notify "$2"
}

body="$(curl -s -m 20 "$HEALTH_URL" || true)"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$HEALTH_URL" || true)"
code="${code:-000}"

# ── 공개 주소(엣지/중계) 감시 — 로컬이 정상일 때만 의미가 있다 ─────────────────
if [ "$code" = "200" ]; then
  resolve_alert local "✅ TeamSpace 로컬 서버 복구 (/api/health → 200)"
  public_base="$(env_get PUBLIC_BASE_URL)"
  public_base="${public_base%/}"
  if [ -n "$public_base" ]; then
    public_url="$public_base/login"
    pcode="$(curl -s -o /dev/null -w '%{http_code}' -m "$PUBLIC_TIMEOUT_SEC" "$public_url" || true)"
    pcode="${pcode:-000}"
    if [ "$pcode" = "200" ]; then
      echo 0 > "$PUBLIC_FAILS_FILE"
      resolve_alert edge "✅ TeamSpace 공개 주소 복구: $public_url → 200"
    else
      pfails=$(( $(cat "$PUBLIC_FAILS_FILE" 2>/dev/null || echo 0) + 1 ))
      echo "$pfails" > "$PUBLIC_FAILS_FILE"
      echo "$LOG_PREFIX public down (local=200, public=$pcode, public_fails=$pfails, url=$public_url)"
      if [ "$pfails" -ge 2 ]; then
        alert edge "🚨 TeamSpace 공개 주소 실패 — 로컬은 정상(200)인데 $public_url → $pcode (연속 ${pfails}회). 엣지/중계 구간 문제: 엣지 VM·Caddy·Tailscale(tailscale serve) 확인"
      fi
    fi
  fi
fi

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
  alert local "🚨 TeamSpace 로컬 서버 다운 — /api/health → $code (연속 ${fails}회, load=$load). web 을 kickstart 합니다. 공개 주소도 이 때문에 실패합니다(엣지 문제 아님)"
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
