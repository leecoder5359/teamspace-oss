#!/usr/bin/env bash
# 백업 복원 리허설 (P7). 최신(또는 지정) 백업을 스크래치 DB 에 복원해 7가지를 점검한다.
# 사용: pnpm restore:rehearsal [백업디렉토리] [--keep]
# 운영 DB 는 건수·마이그레이션 조회만 하고, 쓰기는 teamspace_rehearsal_* 스크래치 DB 에만 한다.
set -euo pipefail

ROOT="${TEAMSPACE_BACKUP_DIR:-$HOME/Backups/teamspace}"
CT="${TEAMSPACE_PG_CONTAINER:-teamspace-postgres}"
LIVE="${TEAMSPACE_DB:-teamspace}"
KEEP=0; DIR=""
for a in "$@"; do
  case "$a" in
    -h|--help) echo "사용: pnpm restore:rehearsal [백업디렉토리] [--keep]"; exit 0 ;;
    --keep) KEEP=1 ;;
    --*) echo "알 수 없는 옵션: $a (사용: [백업디렉토리] [--keep])" >&2; exit 2 ;;
    *) DIR="$a" ;;
  esac
done
[ -n "$DIR" ] || DIR="$(ls -1dt "$ROOT"/*/ 2>/dev/null | head -1 || true)"
DIR="${DIR%/}"
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "백업 디렉토리 없음: ${DIR:-$ROOT/*}" >&2; exit 2; }

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
SCR="teamspace_rehearsal_$STAMP"
TMP="$(mktemp -d)"
FAILS=0; REPORT=""

q() { docker exec "$CT" psql -U teamspace -d "$1" -At -c "$2"; }
ok()   { echo "✅ $1"; REPORT="$REPORT- ✅ $1"$'\n'; }
bad()  { echo "❌ $1"; REPORT="$REPORT- ❌ $1"$'\n'; FAILS=$((FAILS + 1)); }
info() { echo "ℹ️ $1"; REPORT="$REPORT- ℹ️ $1"$'\n'; }
size() { du -h "$1" | cut -f1 | tr -d ' '; }

cleanup() {
  if [ "$KEEP" != 1 ]; then
    docker exec "$CT" dropdb -U teamspace --if-exists "$SCR" >/dev/null 2>&1 || true
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

echo "백업: $DIR  (스크래치 DB: $SCR)"

# 1. 파일 존재
for f in teamspace.dump docs.tar.gz; do
  if [ -f "$DIR/$f" ]; then ok "1 파일 $f ($(size "$DIR/$f"))"; else bad "1 필수 파일 없음: $f"; fi
done
for f in uploads.tar uploads-legacy.tar sites.tar; do
  if [ -f "$DIR/$f" ]; then ok "1 파일 $f ($(size "$DIR/$f"))"; else info "1 $f 없음 (선택)"; fi
done

# 2. 복원
RESTORED=0
if [ -f "$DIR/teamspace.dump" ]; then
  if docker exec "$CT" createdb -U teamspace "$SCR" 2>"$TMP/create.err"; then
    RESTORED=1
    if docker exec -i "$CT" pg_restore -U teamspace -d "$SCR" --no-owner --no-acl < "$DIR/teamspace.dump" 2>"$TMP/restore.err"; then
      ok "2 pg_restore 성공 (경고 $(grep -c . "$TMP/restore.err" || true)줄)"
    else
      bad "2 pg_restore 실패: $(head -3 "$TMP/restore.err" | tr '\n' ' ')"
    fi
  else
    bad "2 스크래치 DB 생성 실패(Docker/컨테이너 $CT 확인): $(head -2 "$TMP/create.err" | tr '\n' ' ')"
  fi
fi

if [ "$RESTORED" = 1 ]; then
  # 3. 마이그레이션 동치 (양쪽 개수 > 0, 개수·최신 이름 일치)
  M="select count(*) || ' ' || coalesce(max(migration_name), '') from \"_prisma_migrations\" where finished_at is not null"
  LM="$(q "$LIVE" "$M" 2>/dev/null || true)"; RM="$(q "$SCR" "$M" 2>/dev/null || true)"
  LC="${LM%% *}"; RC="${RM%% *}"
  PREFIX=0  # 복원본이 운영의 엄격한 앞부분이면(백업 이후 운영에 마이그레이션이 추가됨) 실패가 아니다
  if [ "${LC:-0}" -gt "${RC:-0}" ] && [ "${RC:-0}" -gt 0 ]; then
    MQ='select migration_name from "_prisma_migrations" where finished_at is not null order by migration_name'
    q "$LIVE" "$MQ" 2>/dev/null | head -n "$RC" > "$TMP/mig.live" || true
    q "$SCR" "$MQ" > "$TMP/mig.rest" 2>/dev/null || true
    if [ -s "$TMP/mig.rest" ] && cmp -s "$TMP/mig.live" "$TMP/mig.rest"; then PREFIX=1; fi
  fi
  if [ "${LC:-0}" -gt 0 ] && [ "${RC:-0}" -gt 0 ] && [ "$LM" = "$RM" ]; then ok "3 마이그레이션 일치 ($RM)"
  elif [ "$PREFIX" = 1 ]; then info "3 마이그레이션: 백업 $RC < 운영 $LC (백업 이후 추가됨)"
  else bad "3 마이그레이션 불일치/0건 live=[$LM] restored=[$RM]"; fi

  # 4. 행 수
  for t in User WorkspaceMember Project Page DbRow; do
    L="$(q "$LIVE" "select count(*) from \"$t\"" 2>/dev/null || echo 0)"
    R="$(q "$SCR" "select count(*) from \"$t\"" 2>/dev/null || echo 0)"
    if [ "$R" -gt 0 ] && [ $((R * 100)) -ge $((L * 90)) ]; then ok "4 $t live=$L restored=$R"; else bad "4 $t live=$L restored=$R (0 이거나 90% 미만)"; fi
  done
else
  info "3·4 복원 DB 없음 — 마이그레이션·행 수 점검 건너뜀"
fi

# 5. docs 파일 대조 (Page.filePath 는 docs/ 기준 상대경로 — lib/docFiles.ts DOCS_ROOT)
if [ -f "$DIR/docs.tar.gz" ]; then
  mkdir -p "$TMP/docs-x"
  if ! tar -xzf "$DIR/docs.tar.gz" -C "$TMP/docs-x" 2>"$TMP/tar.err"; then
    bad "5 docs.tar.gz 압축 해제 실패(손상?): $(head -2 "$TMP/tar.err" | tr '\n' ' ')"
  elif [ "$RESTORED" = 1 ]; then
    N=0; H=0
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      N=$((N + 1)); if [ -f "$TMP/docs-x/docs/$p" ]; then H=$((H + 1)); fi
    done < <(q "$SCR" "select \"filePath\" from \"Page\" where \"filePath\" is not null and \"deletedAt\" is null order by random() limit 20" || true)
    if [ "$N" -gt 0 ] && [ $((H * 100)) -ge $((N * 90)) ]; then ok "5 docs 파일 대조 $H/$N"; else bad "5 docs 파일 대조 $H/$N (90% 미만)"; fi
  else
    info "5 docs.tar.gz 해제 성공, DB 없어 대조 건너뜀"
  fi
fi

# 6. 아카이브 읽기
for f in uploads.tar uploads-legacy.tar sites.tar; do
  [ -f "$DIR/$f" ] || continue
  if C="$(tar -tf "$DIR/$f" | wc -l | tr -d ' ')"; then ok "6 $f 읽기 가능 (항목 $C)"; else bad "6 $f 읽기 실패"; fi
done

# 7. 정리는 trap
RES=PASS; [ "$FAILS" = 0 ] || RES=FAIL
echo; echo "결과: $RES"
if [ "$KEEP" = 1 ] && [ "$RESTORED" = 1 ]; then
  echo "--keep: 스크래치 DB 유지 → DATABASE_URL=postgresql://teamspace:teamspace@localhost:${TEAMSPACE_PG_PORT:-5433}/$SCR (앱 부팅 후 /api/health 확인)"
  echo "정리: docker exec $CT dropdb -U teamspace $SCR; rm -rf $TMP"
fi
echo; echo "---- TeamSpace 문서용 ----"
printf '### 백업 복원 리허설 %s\n\n- 백업: `%s`\n- 실행: %s\n%s- 결과: **%s**\n' "$(date +%Y-%m-%d)" "$DIR" "$STAMP" "$REPORT" "$RES"
[ "$RES" = PASS ] || exit 1
