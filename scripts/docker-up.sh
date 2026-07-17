#!/bin/bash
# 부팅(로그인) 시 Docker 데몬을 보장하고 TeamSpace 인프라 컨테이너(postgres/redis)를 띄운다.
# macOS: LaunchAgent com.teamspace.docker 가 RunAtLoad 로 1회 실행 (Docker Desktop 자동 기동 포함).
# 그 외 OS: Docker Desktop 자동 기동은 건너뛰고, 데몬이 이미 떠 있다고 가정한다.
# 재부팅 후 Docker 데몬 부재 → DB ECONNREFUSED → 웹 500 재발 방지용.
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TIMEOUT_SECS=300

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# docker CLI 탐색 (launchd 는 PATH 가 최소라 command -v 실패 시 흔한 설치 경로 fallback)
DOCKER_BIN="$(command -v docker || true)"
if [ -z "$DOCKER_BIN" ]; then
  for c in /usr/local/bin/docker /opt/homebrew/bin/docker; do
    [ -x "$c" ] && DOCKER_BIN="$c" && break
  done
fi
[ -n "$DOCKER_BIN" ] || { log "✗ docker CLI 를 찾을 수 없습니다 — Docker 설치 후 다시 실행하세요"; exit 1; }

log "docker-up 시작"

# 1) Docker 데몬 기동 — macOS 전용(Docker Desktop). 그 외 OS 는 안내만 하고 스킵.
if [ "$(uname)" = "Darwin" ]; then
  # -g: 백그라운드, 이미 떠 있으면 no-op
  open -g -a Docker || { log "✗ Docker.app 실행 실패"; exit 1; }
else
  log "macOS 가 아니므로 Docker Desktop 자동 기동을 건너뜁니다 — Docker 데몬(systemd 등)이 이미 실행 중이어야 합니다"
fi

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
