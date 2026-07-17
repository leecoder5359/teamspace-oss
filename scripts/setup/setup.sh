#!/usr/bin/env sh
# TeamSpace 새 머신 부트스트랩 — 페어링 → 토큰 발급 → 프로젝트 클론 → route-rule → 훅 설치.
# 사용법:
#   setup.sh <base-url> [--with-plugins <owner/repo>]
#   TEAMSPACE_BASE_URL=<base-url> setup.sh [--with-plugins <owner/repo>]
set -eu
TTY=/dev/tty
say() { printf '\033[36m▶ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m! %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat >&2 <<'EOF'
사용법:
  setup.sh <base-url> [--with-plugins <owner/repo>]
  TEAMSPACE_BASE_URL=<base-url> setup.sh [--with-plugins <owner/repo>]

  <base-url>              중앙 TeamSpace 서버 URL (예: https://teamspace.example.com)
  --with-plugins <repo>   선택 — 해당 마켓플레이스(owner/repo)의 플러그인 스택도 설치
EOF
}

# 0) 인자 파싱 — BASE 는 첫 위치 인자 또는 TEAMSPACE_BASE_URL env
BASE="${TEAMSPACE_BASE_URL:-}"
WITH_PLUGINS=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --with-plugins)
      [ $# -ge 2 ] || { usage; die "--with-plugins 에 <owner/repo> 값이 필요합니다."; }
      WITH_PLUGINS="$2"; shift 2 ;;
    *) BASE="$1"; shift ;;
  esac
done
[ -n "$BASE" ] || { usage; exit 1; }
BASE="${BASE%/}"

# 1) 전제
have claude || die "Claude Code CLI 가 없습니다. 먼저 설치: https://claude.com/claude-code"
have brew   || die "Homebrew 가 필요합니다: https://brew.sh"
for b in node pnpm git jq; do have "$b" || { say "$b 설치"; brew install "$b"; }; done
have tailscale || { say "Tailscale 설치"; brew install --cask tailscale; }

# 2) 서버 도달 (tailnet 내부 서버라면 서버 운영자의 tailnet 에 먼저 로그인 필요)
tailscale status >/dev/null 2>&1 || warn "Tailscale 미로그인 상태 — 서버가 tailnet 내부라면 서버 운영자의 tailnet 에 로그인 후 다시 실행하세요."
curl -sf "$BASE/api/health" >/dev/null || die "중앙 서버($BASE) 응답 없음 — 서버 상태와 네트워크(tailnet 로그인 여부)를 확인하세요."

# 3) 페어링(Google 로그인) — 이미 토큰 있으면 skip
CFG="$HOME/.claude/teamspace.json"
mkdir -p "$HOME/.claude/hooks"
CODE=""
if [ -f "$CFG" ] && grep -q '"token"' "$CFG"; then
  say "teamspace.json 존재 — 페어링 skip"
else
  CODE=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  say "브라우저에서 로그인·승인: $BASE/setup/pair?code=$CODE"
  ( open "$BASE/setup/pair?code=$CODE" 2>/dev/null || true )
  say "승인 대기 중..."
  TOKEN=""
  i=0
  while [ "$i" -lt 150 ]; do   # 5분(2초×150)
    RESP=$(curl -s -w '\n%{http_code}' "$BASE/api/pair/$CODE" 2>/dev/null || printf '\n000')
    HTTP=$(printf '%s' "$RESP" | tail -n1)
    if [ "$HTTP" = "200" ]; then
      TOKEN=$(printf '%s' "$RESP" | sed '$d' | jq -r .token)
      break
    fi
    [ "$HTTP" = "410" ] && die "페어링 만료 — 다시 실행하세요."
    sleep 2; i=$((i+1)); continue
  done
  [ -n "$TOKEN" ] || die "승인 타임아웃 — 다시 실행하세요."
  printf '{ "base": "%s", "token": "%s" }\n' "$BASE" "$TOKEN" > "$CFG"
  say "teamspace.json 작성 완료"
fi
TOKEN=$(jq -r .token "$CFG")

# 4) 프로젝트 선택 + 클론 + route-rule
PROJECTS=$(curl -s -H "x-ws-token: $TOKEN" "$BASE/api/projects") || die "프로젝트 목록 조회 실패"
PROJ_LIST=$(mktemp)
REG_LIST=$(mktemp)
JQ_OUT=$(printf '%s' "$PROJECTS" | jq -r '.projects[] | "\(.id)\t\(.name)\t\(.repoUrl // "-")"') || die "응답 파싱 실패"
printf '%s\n' "$JQ_OUT" | nl -w2 -s') ' > "$PROJ_LIST"
say "프로젝트 목록:"; cat "$PROJ_LIST"
printf '설치할 프로젝트 번호(공백구분, 전체=a): ' > "$TTY"
read -r SEL < "$TTY" || die "대화 입력을 열 수 없습니다(TTY 없음). 터미널에서 직접 실행하세요."
[ "$SEL" = "a" ] && SEL=$(sed -E 's/^[[:space:]]*([0-9]+)\).*/\1/' "$PROJ_LIST" | tr '\n' ' ')
TS_DIR=""   # teamspace 레포가 클론되면 여기에 경로가 담긴다(아래 MCP 등록용)
for n in $SEL; do
  LINE=$(sed -n "${n}p" "$PROJ_LIST") || continue
  [ -z "$LINE" ] && continue
  PID=$(printf '%s' "$LINE" | awk -F'\t' '{print $1}' | sed -E 's/^[[:space:]]*[0-9]+\) //')
  NAME=$(printf '%s' "$LINE" | awk -F'\t' '{print $2}')
  URL=$(printf '%s' "$LINE" | awk -F'\t' '{print $3}')
  if [ "$URL" = "-" ]; then warn "$NAME: repoUrl 없음 — 클론 skip(수동 클론 후 재실행)"; continue; fi
  ORG=$(printf '%s' "$URL" | sed -E 's#(\.git)?$##' | sed -E 's#.*[/:]([^/]+)/([^/]+)$#\1#')
  REPO=$(printf '%s' "$URL" | sed -E 's#(\.git)?$##' | sed -E 's#.*/##')
  DEST="$HOME/dev/$ORG/$REPO"
  if [ -d "$DEST/.git" ]; then say "$REPO 이미 클론됨 — fetch"; git -C "$DEST" fetch --all -q || true
  else say "$REPO 클론 → $DEST"; mkdir -p "$HOME/dev/$ORG"; git clone -q "$URL" "$DEST" || warn "클론 실패($REPO) — $DEST 확인 후 재실행"; fi
  [ -f "$DEST/scripts/mcp-server.ts" ] && TS_DIR="$DEST"   # teamspace 레포 감지(MCP 쓰기 툴)
  # route-rule 등록: 첫 실행=페어링 게이트(CODE), 재실행=토큰. HTTP 코드로 실제 성공 여부 판정(2xx만 성공).
  RR_BODY=$(jq -nc --arg cwd "$DEST" --arg pid "$PID" '{cwd:$cwd,projectId:$pid}')
  if [ -n "$CODE" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/pair/$CODE/route-rule" -H 'content-type: application/json' -d "$RR_BODY" || echo 000)
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/route-rules" -H "x-ws-token: $TOKEN" -H 'content-type: application/json' \
      -d "$(jq -nc --arg c "$DEST" --arg p "$PID" '{cwdPrefix:$c,projectId:$p}')" || echo 000)
  fi
  case "$code" in
    2*) say "route-rule 등록: $DEST"; printf '%s\n' "$DEST" >> "$REG_LIST" ;;
    *) warn "route-rule 실패(HTTP $code, $REPO) — 서버에서: pnpm ws route-rule add $DEST --project $PID" ;;
  esac
done
rm -f "$PROJ_LIST"

# 5) (선택) 플러그인 마켓플레이스 + 스택 — --with-plugins <owner/repo> 를 준 경우만.
#    스코프 이름은 마켓플레이스 인자의 레포명에서 파생한다(owner/repo → repo).
PLUGIN_SCOPE=""
if [ -n "$WITH_PLUGINS" ]; then
  PLUGIN_SCOPE=$(printf '%s' "$WITH_PLUGINS" | sed -E 's#(\.git)?$##' | sed -E 's#.*/##')
  say "플러그인 마켓플레이스 추가: $WITH_PLUGINS (스코프 @$PLUGIN_SCOPE)"
  claude plugin marketplace add "$WITH_PLUGINS" 2>/dev/null || true
  for p in "$PLUGIN_SCOPE" superpowers understand-anything agentmemory; do
    claude plugin install "$p@$PLUGIN_SCOPE" 2>/dev/null || true
  done
fi

# 5.5) teamspace MCP 등록 — teamspace 레포가 클론된 경우만(쓰기 툴 mcp__teamspace__*).
#      MCP 서버는 DB가 아니라 teamspace.json(base+token)으로 API 호출 → 타일넷으로 동작.
if [ -n "${TS_DIR:-}" ] && [ -f "$TS_DIR/scripts/mcp-server.ts" ] && command -v claude >/dev/null 2>&1; then
  say "teamspace MCP 준비 — $TS_DIR 의존성 설치(pnpm i)"
  if ( cd "$TS_DIR" && pnpm i >/dev/null 2>&1 ); then
    claude mcp remove -s user teamspace >/dev/null 2>&1 || true
    if claude mcp add -s user teamspace -- pnpm --dir "$TS_DIR" exec tsx scripts/mcp-server.ts >/dev/null 2>&1; then
      say "teamspace MCP 등록 완료(user 스코프 — 모든 레포에서 쓰기 툴 사용 가능)"
    else
      warn "teamspace MCP 등록 실패 — 수동: claude mcp add -s user teamspace -- pnpm --dir $TS_DIR exec tsx scripts/mcp-server.ts"
    fi
  else
    warn "pnpm i 실패($TS_DIR) — MCP 등록 건너뜀. 수동으로 cd $TS_DIR && pnpm i 후 claude mcp add"
  fi
fi

# 6) 전역 훅 3종 (서버 최신본으로 덮어씀)
for h in teamspace-context teamspace-session-end deny-repo-docs; do
  curl -sf "$BASE/setup/hooks/$h.mjs" -o "$HOME/.claude/hooks/$h.mjs" || die "$h 훅 내려받기 실패"
done

# 7) settings.json 병합(jq) — 기존 키 보존
SETTINGS="$HOME/.claude/settings.json"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
TMP=$(mktemp)
jq '
  .hooks.PreToolUse = ((.hooks.PreToolUse // []) + [{matcher:"Write|Edit|MultiEdit|NotebookEdit",hooks:[{type:"command",command:"node \"$HOME/.claude/hooks/deny-repo-docs.mjs\""}]}] | unique) |
  .hooks.SessionStart = ((.hooks.SessionStart // []) + [{hooks:[{type:"command",command:"node \"$HOME/.claude/hooks/teamspace-context.mjs\""}]}] | unique) |
  .hooks.SessionEnd = ((.hooks.SessionEnd // []) + [{hooks:[{type:"command",command:"node \"$HOME/.claude/hooks/teamspace-session-end.mjs\""}]}] | unique) |
  .env = ((.env // {}) + {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"})
' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS" || { warn "settings.json 병합 실패 — 수동 확인 필요"; rm -f "$TMP"; }

# 7.5) (선택) enabledPlugins 병합 — --with-plugins 를 준 경우만
if [ -n "$PLUGIN_SCOPE" ]; then
  TMP=$(mktemp)
  jq --arg s "$PLUGIN_SCOPE" '
    .enabledPlugins = ((.enabledPlugins // {})
      + {("superpowers@"+$s):true,("understand-anything@"+$s):true,("agentmemory@"+$s):true,($s+"@"+$s):true})
  ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS" || { warn "enabledPlugins 병합 실패 — 수동 확인 필요"; rm -f "$TMP"; }
fi

# 8) agentmemory env(zshrc) — 이미 있으면 skip
RC="$HOME/.zshrc"
if ! grep -q AGENTMEMORY_INJECT_CONTEXT "$RC" 2>/dev/null; then
  cat >> "$RC" <<'RCEOF'
export AGENTMEMORY_URL="http://localhost:3111"
export AGENTMEMORY_SECRET="$(grep '^AGENTMEMORY_SECRET=' ~/.agentmemory/.env 2>/dev/null | cut -d= -f2)"
export AGENTMEMORY_INJECT_CONTEXT="false"   # W3: 팀 주입은 teamspace 훅 단일
RCEOF
fi

# 9) 골든셋 검증
say "검증:"
curl -sf "$BASE/api/health" >/dev/null && echo "  ✅ 중앙서버 도달" || echo "  ❌ 서버"
[ -f "$CFG" ] && echo "  ✅ teamspace.json" || echo "  ❌ teamspace.json"
ls "$HOME/.claude/hooks/"*.mjs >/dev/null 2>&1 && echo "  ✅ 전역 훅 3종" || echo "  ❌ 훅"
if [ -n "$PLUGIN_SCOPE" ]; then
  claude plugin list 2>/dev/null | grep -q "$PLUGIN_SCOPE" && echo "  ✅ 플러그인 스택(@$PLUGIN_SCOPE)" || echo "  ⚠️ 플러그인 확인 필요"
fi
[ "$(jq -r '.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS // empty' "$HOME/.claude/settings.json" 2>/dev/null)" = "1" ] && echo "  ✅ Agent Teams(env)" || echo "  ⚠️ Agent Teams env 미설정"
claude mcp list 2>/dev/null | grep -q teamspace && echo "  ✅ teamspace MCP(쓰기 툴)" || echo "  — teamspace MCP 미등록(teamspace 레포 미클론 시 정상)"
if [ -s "$REG_LIST" ]; then
  RULES=$(curl -s -H "x-ws-token: $TOKEN" "$BASE/api/route-rules") || RULES=""
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    if printf '%s' "$RULES" | grep -qF "$d"; then
      echo "  ✅ route-rule: $d"
    else
      echo "  ⚠️ route-rule 누락: $d"
    fi
  done < "$REG_LIST"
fi
rm -f "$REG_LIST"
say "완료 — 새 세션(레포 폴더에서)을 열어 <teamspace-context> 가 뜨는지 확인하세요."
