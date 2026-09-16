#!/usr/bin/env bash
# TeamSpace 로컬 백업 (감사 missed-2 1단계).
#   - Postgres: docker exec pg_dump (custom format)
#   - 문서 원본: docs/ tar
#   - 첨부 원본: public/uploads/ tar   ← 격차 E4
#   - 보관: ~/Backups/teamspace/<타임스탬프>/, 최근 14개 로테이션
# 사용: pnpm backup   (오프사이트·자동 스케줄은 W7 배포에서)
#
# E4: 첨부는 DB 도 docs/ 도 아닌 public/uploads/ 로컬 디스크에만 있었다. DB 는
# 매일 백업되는데 그 DB 가 가리키는 파일은 아니어서, 디스크를 잃으면 **행은 살아
# 있고 그림만 사라진 문서**가 남는다. 백업이 절반만 도는 건 백업이 없는 것보다
# 나쁘다 — 복구했다고 믿게 되기 때문이다.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_ROOT="${TEAMSPACE_BACKUP_DIR:-$HOME/Backups/teamspace}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"
KEEP=14

mkdir -p "$DEST"

echo "→ Postgres 덤프"
docker exec teamspace-postgres pg_dump -U teamspace -d teamspace -Fc > "$DEST/teamspace.dump"

echo "→ docs/ 아카이브"
tar -czf "$DEST/docs.tar.gz" -C "$REPO_DIR" docs

# 첨부는 두 곳에 있을 수 있다: 새 저장소(DATA_DIR/uploads, 기본 <repo>/data/uploads)와
# 옛 위치(public/uploads). OSS 후속에서 위치를 옮겼지만 이미 올라간 파일은 옮기지 않으므로
# **둘 다** 담아야 백업이 완전하다. (이미지·PDF 가 대부분이라 gzip 을 다시 걸지 않는다.)
UPLOAD_NEW="${TEAMSPACE_DATA_DIR:-$REPO_DIR/data}/uploads"
echo "→ 첨부 아카이브 (새 위치: $UPLOAD_NEW)"
if [ -d "$UPLOAD_NEW" ]; then
  tar -cf "$DEST/uploads.tar" -C "$(dirname "$UPLOAD_NEW")" "$(basename "$UPLOAD_NEW")"
else
  echo "  (새 위치 없음 — 건너뜀)"
fi
echo "→ 첨부 아카이브 (옛 위치: public/uploads)"
if [ -d "$REPO_DIR/public/uploads" ]; then
  tar -cf "$DEST/uploads-legacy.tar" -C "$REPO_DIR/public" uploads
else
  echo "  (옛 위치 없음 — 건너뜀)"
fi

# 퍼블리시 사이트 번들(HTML 퍼블리시). DB 의 PublishedSite/SiteVersion 행이 가리키는 파일.
SITES_DIR="${TEAMSPACE_DATA_DIR:-$REPO_DIR/data}/sites"
echo "→ 퍼블리시 사이트 아카이브 ($SITES_DIR)"
if [ -d "$SITES_DIR" ]; then
  tar -cf "$DEST/sites.tar" -C "$(dirname "$SITES_DIR")" "$(basename "$SITES_DIR")"
else
  echo "  (없음 — 건너뜀)"
fi

echo "→ 로테이션 (최근 $KEEP 개 유지)"
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -rf "$old"
done

echo "완료: $DEST"
ls -lh "$DEST"
