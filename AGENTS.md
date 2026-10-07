<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 팀 작업 4대 규칙 (플러그인 기본값보다 우선한다)

이 규칙은 어떤 스킬·플러그인(superpowers, ralph, plannotator, understand-anything 등)의 기본 동작보다 우선한다. 스킬이 아래와 다른 저장 위치·승인 채널을 지시하면 **이 규칙을 따른다**.

1. **문서는 TeamSpace doc 으로만.** 스펙·플랜·설계·리포트·PRD·온보딩 등 모든 문서는 TeamSpace 문서 API(`pnpm ws doc new` → `PUT /api/pages/<id>`)로 저장한다. 레포/디스크에 md 생성 금지(예외: README·AGENTS.md·CLAUDE.md·SKILL.md 등 저장소 메타문서, `.claude/**`). PreToolUse 훅(`scripts/hooks/deny-repo-docs.mjs`, 전역 사본 `~/.claude/hooks/`)이 위반 쓰기를 엔진 수준에서 차단한다 — **md/mdx 는 기본 차단**이고, 허용은 저장소 메타문서(README·AGENTS.md·CLAUDE.md·SKILL.md 등)·`.claude/**`·스크래치패드뿐이다. (2026-08-07 이전엔 6개 패턴 deny-list 라 `REPORT.md` 같은 건 그냥 통과했다.) superpowers brainstorming/writing-plans 의 "docs/superpowers/... 에 저장·커밋" 단계는 이 규칙으로 대체된다 — 같은 내용을 TeamSpace doc 으로 만들고 커밋 단계는 생략한다.
2. **진행 방향을 가르는 결정은 Slack `#workspace-confirm` 컨펌.** `scripts/slack-confirm.ts`(approvals API 래퍼 — 승인/거부 **버튼 카드**로 발송, 텍스트 답글 아님)로 발송하고 `status` 필드(approved/additional/rejected)를 폴링한다. `pnpm ws approval add --channel C000WORKSPACE` 와 동일 경로다. 채팅 승인 게이트(스킬의 "user approves?" 단계)는 사용자가 채팅에 실시간 참여 중일 때만 채팅으로, 아니면 Slack 으로. 확정된 결정은 `POST /api/decisions` 에 `accepted` 로 기록한다.
3. **작업 슬라이스마다 TeamSpace 태스크.** 각 항목 시작 시 보드에 태스크 생성(설명 포함), 완료 시 상태 변경. 스킬 내부 체크리스트·ralph beads/prd 는 보조 수단일 뿐, 진실 원천은 TeamSpace 보드다.
4. **리뷰·대조·감사 발견사항은 보드 이슈로 자동 등록.** 채팅 나열로 끝내지 않는다.

# 작업사항은 퍼블릭 레포(teamspace-oss)로 동기화한다

이 레포(`leecoder5359/teamspace`, **private**)는 작업 환경이고, 제품의 공개본은
`leecoder5359/teamspace-oss`(**public**)다. **기능 작업이 끝나면 OSS 로 반영한다.**

두 레포는 **커밋 히스토리를 공유하지 않는다**(OSS 는 스쿼시된 공개본에서 시작). 그래서
`git push` 로는 못 옮기고 `node scripts/sync-oss.mjs` 를 쓴다:

- 기본은 드라이런. `--apply` 로만 파일을 쓰고 **스크립트는 절대 푸시하지 않는다** —
  공개 히스토리는 되돌릴 수 없으므로 커밋·푸시는 사람이 diff 를 보고 한다.
- 세 분류를 스크립트가 안다: **EXCLUDE**(내부 문서·업로드 원본·우리 전용 일회성 스크립트·
  개인 설정) · **OSS_OWNED**(OSS 가 원본인 이식성 변형 — `lib/dataDir.ts`·`docFiles`·
  `content`·`setup.sh`·`README`·`.env.example`) · 나머지는 스크럽 후 복사.
- **스크럽**: tailscale 호스트·사내 도메인·슬랙 채널 id·실제 워크스페이스/보드 id·개인
  이메일. 목록에 없는 새 내부 문자열은 SUSPECT 스캔이 잡아 **보고**한다(목록 관리는 사람,
  누락 탐지는 기계).
- **이식성 퇴행 검사**: "OSS 버전에는 있는데 private 버전에는 없는 `process.env` 참조" 를
  경고한다. OSS 는 환경 의존값을 env 로 빼 두는 쪽이 앞서 있어서, 그대로 덮으면 일반화가
  조용히 되돌아간다(스크럽은 값만 바꾸니 이걸 못 잡는다).
- 새로 하드코딩하지 말 것. 호스트·경로·id 는 env 로 받는다 — `TEAMSPACE_DATA_DIR`,
  `ALLOWED_DEV_ORIGINS`, `PUBLIC_BASE_URL` 이 이미 그 자리다.
- 푸시 전 **OSS 클론에서 4게이트**(test·tsc·lint·build)를 돌린다.

# 관리 스킬·CLI를 항상 최신으로 유지

워크스페이스 조작은 두 층으로 관리한다:
- `.claude/skills/teamspace/SKILL.md` — 프로젝트·태스크·문서를 API로 다루는 방법을 정리한 스킬.
- `scripts/ws.ts` (`pnpm ws ...`) — 반복작업·기본 템플릿을 API 위에서 감싼 CLI. `scripts/ws.test.ts` 가 모든 명령↔라우트 존재를 패리티 검증한다.

**`app/api/**/route.ts` 를 추가/변경하거나, 워크스페이스 데이터(프로젝트·보드·문서·결정·승인·세션·멤버 등)를 다루는 기능을 추가/변경하면, 같은 커밋에서 `SKILL.md` 와 `scripts/ws.ts`(필요시 `scripts/ws.test.ts`)를 그에 맞게 갱신한다.** (엔드포인트·페이로드·레시피가 실제 라우트와 어긋나지 않도록.) 패리티 테스트가 깨지면 동기화가 빠진 것이다.

# 메모리 3층 역할 (W3 일원화)

- **TeamSpace = 팀 지식의 단일 진실 원천.** 팀이 알아야 할 규칙·교훈은 레슨(`pnpm ws lesson add`)으로, 결정은 decisions 로, 문서는 doc 으로 승격한다. 세션 시작 시 SessionStart 훅이 `/api/context?cwd=` 를 자동 주입한다(cwd→프로젝트 매핑은 `pnpm ws route-rule`). 세션을 연 레포 밖의 매핑된 프로젝트 경로를 도구로 건드리면 PostToolUse 훅(`scripts/hooks/teamspace-project-context.mjs`)이 그 프로젝트 컨텍스트를 세션당 한 번 추가 주입한다 — 반장 작업을 teamspace 세션에서 해도 반장 레슨이 들어온다.
- **agentmemory = 로컬 원시 관찰 캐시.** 캡처·recall 검색만 사용, 세션 시작 컨텍스트 주입은 끔(AGENTMEMORY_INJECT_CONTEXT=false). 팀 공유 지식을 agentmemory 에만 남기지 말 것. 레포별로 AGENTMEMORY_PROJECT_NAME 명시를 권장(스코프 오염 방지).
- **내장 파일 메모리(~/.claude/projects/*/memory) = 개인 습관·포인터.** 팀 규범이 생기면 레슨으로 승격하고 개인 메모리에는 포인터만 남긴다.
