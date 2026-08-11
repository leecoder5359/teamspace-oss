#!/bin/bash
# 부팅(로그인) 시 Docker Desktop을 띄우고 TeamSpace 인프라 컨테이너(postgres/redis)를 보장한다.
# LaunchAgent com.teamspace.docker 가 RunAtLoad 로 1회 실행 — plist 템플릿은
# 공개 배포본의 scripts/launchd/templates/com.teamspace.docker.plist.tmpl (deploy.sh 는 설치하지 않음, README 참고).
# 재부팅 후 Docker 데몬 부재 → DB ECONNREFUSED → 웹 500 재발 방지용.
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_BIN="$(command -v docker || echo /usr/local/bin/docker)"
TIMEOUT_SECS=300

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "docker-up 시작"

# 1) Docker Desktop 기동 (-g: 백그라운드, 이미 떠 있으면 no-op)
open -g -a Docker || { log "✗ Docker.app 실행 실패"; exit 1; }

# 2) 데몬 준비 대기 (최대 ${TIMEOUT_SECS}초)
elapsed=0
until "$DOCKER_BIN" info >/dev/null 2>&1; do
  if [ "$elapsed" -ge "$TIMEOUT_SECS" ]; then
    log "✗ ${TIMEOUT_SECS}초 내 Docker 데몬 준비 안 됨"
    exit 1
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done
log "✓ Docker 데몬 준비됨 (${elapsed}초)"

# 3) 인프라 컨테이너 보장 (restart 정책이 있어도 명시 up 으로 이중 안전망)
cd "$REPO_DIR" || exit 1
"$DOCKER_BIN" compose up -d postgres redis || { log "✗ compose up 실패"; exit 1; }

# 4) postgres healthy 대기 (최대 60초)
elapsed=0
until [ "$("$DOCKER_BIN" inspect -f '{{.State.Health.Status}}' teamspace-postgres 2>/dev/null)" = "healthy" ]; do
  if [ "$elapsed" -ge 60 ]; then
    log "✗ postgres 60초 내 healthy 안 됨"
    exit 1
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done
log "✓ postgres healthy — 완료"
