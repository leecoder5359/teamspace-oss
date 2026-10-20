<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 팀 작업 4대 규칙 (플러그인 기본값보다 우선한다)

필수 레슨 4건이 정본(세부·사례 포함)이며, 어떤 스킬·플러그인(superpowers·ralph·plannotator·understand-anything) 기본값보다 우선한다.

1. 문서는 TeamSpace doc 으로만 — 레포에 md 금지(메타문서 예외). cmr6mbdsx0002on1yoibzeo2e
2. 방향을 가르는 결정은 Slack #workspace-confirm 버튼 카드로 컨펌. cmr6mbdti0003on1yxmpks044
3. 작업 슬라이스마다 보드 태스크 — 보드가 진실 원천. cmr6mbdu00004on1yc2d44uer
4. 리뷰·대조·감사 발견사항은 보드 이슈로. cmr6mbdug0005on1yeai0tsxj

집행: PreToolUse 훅 `scripts/hooks/deny-repo-docs.mjs`(md/mdx 기본 차단).

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

# 메모리 3층 역할 (2026-10-20 기준)

- 정본은 레슨 cmvfenyan00010p1yv4oluttk(레슨·메모리 등록 규칙, 집행 훅 포함).
- 주입: SessionStart `/api/context?cwd=`(매핑 `pnpm ws route-rule`) · PostToolUse `teamspace-project-context.mjs`(매핑된 다른 프로젝트, 세션당 1회) · SubagentStart(role:* + 세션 레포 레슨).
- agentmemory 는 2026-10-16 부터 꺼져 있다(데이터 보존). 의존하지 않는다.

# 에이전트 게이트 (서브에이전트가 먼저 읽는 절)

역할 에이전트(`.claude/agents/implementer·reviewer·researcher`, 전역 사본은 `bash scripts/sync-agents.sh`)가 이 레포에서 쓰는 명령과 금지 사항. 설계 doc cmvfbot82 §3.3.

- **게이트 순서** (변경 파일·영역만):
  1. `rm -f tsconfig.tsbuildinfo && pnpm exec tsc --noEmit`
  2. `pnpm exec eslint <변경 파일>`
  3. `pnpm exec vitest run <변경 영역 경로>`
- **`next build` 금지** — :3002 가 `next start` 중이라 `.next` 를 덮으면 서비스가 깨진다. 빌드 검증은 배포 담당(사람)이 한다.
- **테스트 DB는 `teamspace_test`** — 워크트리마다 분리한 DB 를 쓴다(다른 워크트리 테스트와 겹치면 서로 깨뜨린다). 개발 DB 로 테스트하지 않는다.
- **`pnpm add` 는 메인 체크아웃에서만** — 워크트리에서 의존성을 바꾸면 lockfile 이 갈라진다. 필요하면 `BLOCKED` 로 보고.
- **`pnpm ws` 는 teamspace cwd 전용** — `/Users/ljun/dev/ljun/teamspace` 에서 **별도 Bash 호출**로 실행한다. 다른 레포 `cd` 체인에 섞으면 조용히 실패한다.
