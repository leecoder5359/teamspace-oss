#!/usr/bin/env bash
# TeamSpace 로컬 백업 (감사 missed-2 1단계).
#   - Postgres: docker exec pg_dump (custom format)
#   - 데이터 디렉토리(docs/content/uploads): tar
#   - 보관: ~/Backups/teamspace/<타임스탬프>/, 최근 14개 로테이션
# 사용: pnpm backup   (오프사이트·자동 스케줄은 W7 배포에서)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${TEAMSPACE_DATA_DIR:-$REPO_DIR/data}"
BACKUP_ROOT="${TEAMSPACE_BACKUP_DIR:-$HOME/Backups/teamspace}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"
KEEP=14

mkdir -p "$DEST"

echo "→ Postgres 덤프"
docker exec teamspace-postgres pg_dump -U teamspace -d teamspace -Fc > "$DEST/teamspace.dump"

echo "→ 데이터 디렉토리 아카이브 ($DATA_DIR)"
tar -czf "$DEST/data.tar.gz" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"

echo "→ 로테이션 (최근 $KEEP 개 유지)"
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -rf "$old"
done

echo "완료: $DEST"
ls -lh "$DEST"
