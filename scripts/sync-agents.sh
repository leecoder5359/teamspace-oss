#!/usr/bin/env bash
# 역할 에이전트 정의(.claude/agents/*.md)를 ~/.claude/agents/ 로 복사한다.
#
# 정본은 레포 .claude/agents/ 다(버전 관리). 전역 사본이 있어야 어느 레포 세션에서든
# implementer·reviewer·researcher 를 띄울 수 있다 — scripts/hooks/*.mjs 를 ~/.claude/hooks/ 로
# 복사해 두는 것과 같은 관행. 레포에 있는 파일만 다루므로 ~/.claude/agents/ 에만 있는
# 파일(planning-reviewer.md 등)은 건드리지 않는다. 몇 번 돌려도 결과는 같다.
# 사용: bash scripts/sync-agents.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_DIR/.claude/agents"
DST_DIR="${HOME}/.claude/agents"

mkdir -p "$DST_DIR"

added=0 updated=0 same=0
for src in "$SRC_DIR"/*.md; do
  [ -e "$src" ] || { echo "no agent files in $SRC_DIR"; exit 0; }
  name="$(basename "$src")"
  dst="$DST_DIR/$name"
  if [ ! -e "$dst" ]; then
    cp "$src" "$dst"; added=$((added + 1)); echo "A  $name"
  elif cmp -s "$src" "$dst"; then
    same=$((same + 1)); echo "=  $name"
  else
    echo "M  $name"
    diff -u "$dst" "$src" | sed 's/^/   /' || true
    cp "$src" "$dst"; updated=$((updated + 1))
  fi
done

echo "sync-agents: added=$added updated=$updated unchanged=$same → $DST_DIR"
