<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 팀 작업 4대 규칙 (플러그인 기본값보다 우선한다)

이 규칙은 어떤 스킬·플러그인의 기본 동작보다 우선한다. 스킬이 아래와 다른 저장 위치·승인 채널을 지시하면 **이 규칙을 따른다**.

1. **문서는 TeamSpace doc 으로만.** 스펙·플랜·설계·리포트·PRD·온보딩 등 모든 문서는 TeamSpace 문서 API(`pnpm ws doc new` → `PUT /api/pages/<id>`)로 저장한다. 레포/디스크에 md 생성 금지(예외: README·AGENTS.md·CLAUDE.md·SKILL.md 등 저장소 메타문서, `.claude/**`). PreToolUse 훅(`scripts/hooks/deny-repo-docs.mjs`)을 등록하면 위반 쓰기를 엔진 수준에서 차단할 수 있다. 스킬이 "레포에 플랜을 저장·커밋"하라고 지시하면 이 규칙으로 대체한다 — 같은 내용을 TeamSpace doc 으로 만들고 커밋 단계는 생략한다.
2. **진행 방향을 가르는 결정은 Slack 컨펌 채널(예: `#workspace-confirm`)로.** `scripts/slack-confirm.ts` 로 발송하고 답글(1=승인/2=추가요청/3=거부)을 폴링한다. 채팅 승인 게이트(스킬의 "user approves?" 단계)는 사용자가 채팅에 실시간 참여 중일 때만 채팅으로, 아니면 Slack 으로. 확정된 결정은 `POST /api/decisions` 에 `accepted` 로 기록한다. (Slack 미연동 환경이면 채팅 승인으로 대신하되, 결정 기록은 동일하게 남긴다.)
3. **작업 슬라이스마다 TeamSpace 태스크.** 각 항목 시작 시 보드에 태스크 생성(설명 포함), 완료 시 상태 변경. 스킬 내부 체크리스트는 보조 수단일 뿐, 진실 원천은 TeamSpace 보드다.
4. **리뷰·대조·감사 발견사항은 보드 이슈로 자동 등록.** 채팅 나열로 끝내지 않는다.

# 관리 스킬·CLI를 항상 최신으로 유지

워크스페이스 조작은 두 층으로 관리한다:
- `.claude/skills/teamspace/SKILL.md` — 프로젝트·태스크·문서를 API로 다루는 방법을 정리한 스킬.
- `scripts/ws.ts` (`pnpm ws ...`) — 반복작업·기본 템플릿을 API 위에서 감싼 CLI. `scripts/ws.test.ts` 가 모든 명령↔라우트 존재를 패리티 검증한다.

**`app/api/**/route.ts` 를 추가/변경하거나, 워크스페이스 데이터(프로젝트·보드·문서·결정·승인·세션·멤버 등)를 다루는 기능을 추가/변경하면, 같은 커밋에서 `SKILL.md` 와 `scripts/ws.ts`(필요시 `scripts/ws.test.ts`)를 그에 맞게 갱신한다.** (엔드포인트·페이로드·레시피가 실제 라우트와 어긋나지 않도록.) 패리티 테스트가 깨지면 동기화가 빠진 것이다.

# 메모리 3층 역할

- **TeamSpace = 팀 지식의 단일 진실 원천.** 팀이 알아야 할 규칙·교훈은 레슨(`pnpm ws lesson add`)으로, 결정은 decisions 로, 문서는 doc 으로 승격한다. SessionStart 훅(`scripts/hooks/teamspace-context.mjs`)을 등록하면 세션 시작 시 `/api/context?cwd=` 가 자동 주입된다(cwd→프로젝트 매핑은 `pnpm ws route-rule`).
- **로컬 관찰 캐시(agentmemory 등을 쓰는 경우) = 원시 관찰 기록.** 캡처·recall 검색만 사용하고, 팀이 공유해야 할 지식을 로컬 캐시에만 남기지 말 것 — TeamSpace 로 승격한다.
- **에이전트 개인 메모리 = 개인 습관·포인터.** 팀 규범이 생기면 레슨으로 승격하고 개인 메모리에는 포인터만 남긴다.
