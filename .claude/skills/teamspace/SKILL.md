---
name: teamspace
description: TeamSpace 앱(이 레포)의 프로젝트·태스크(보드)·문서를 HTTP API로 관리할 때 사용. "태스크 상태 바꿔/완료 처리", "보드 카드 추가", "프로젝트 만들어", "문서 추가/연결", "결정·리스크·용어 등록", "리마인더 추가" 같은 요청이나, 일회성 DB 스크립트 대신 API로 워크스페이스를 조작해야 할 때.
---

# TeamSpace 관리

TeamSpace는 Next.js(App Router) + Prisma 앱이다. 워크스페이스의 **프로젝트 / 태스크(보드 행) / 문서(file-first) / 결정·리스크·QA·용어·승인·세션·멤버** 를 전부 `/api/*` HTTP 엔드포인트로 다룬다. **DB를 직접 건드리지 말고 API를 쓴다** (워크스페이스 컨텍스트·파일 저장·검증이 라우트에 들어있음).

## 먼저 이걸 써라: `pnpm ws` CLI

반복작업·기본 템플릿은 **`scripts/ws.ts` CLI** 가 API를 감싸 한 줄로 처리한다(매번 curl 레시피를 떠올리지 말 것). dev 서버(`http://localhost:3002`, 없으면 `pnpm exec next dev -p 3002`)가 떠 있어야 한다.

```bash
pnpm ws help                                  # 전체 명령 목록
pnpm ws task add "버그 수정" --status "진행 중" --due 2026-07-01
pnpm ws task done <rowId>                      # 상태→완료
pnpm ws doc new "회의록" --project <id>
pnpm ws decision add "DB는 SQLite로" --status accepted
pnpm ws approval add "배포 승인?" --body "main 머지" --kind deploy --high
```

명령 그룹: `board · task · doc · project · decision · risk · qa · glossary · changelog · entity · onboarding · dod · approval · remind · member · team · token(에이전트 토큰) · ws(info/rename) · search · lint · graph · llm(classify)`. 각 명령은 내부적으로 아래 라우트를 호출한다 — CLI가 못 덮는 케이스나 디버깅 때만 raw API를 직접 쓴다. `scripts/ws.test.ts` 가 모든 명령↔라우트 존재를 패리티 검증한다.

## 핵심 규칙 (CLI든 raw API든 공통)

- 상태/선택 옵션 ID는 워크스페이스마다 다르다 → **하드코딩 말고 항상 조회해서 매핑**(CLI는 이름으로 자동 매핑: `--status "진행 중"`).
- 모든 라우트는 `requireCtx(minRole?)`(lib/workspace.ts)로 컨텍스트+RBAC 해석: ① 세션(매 요청 멤버십 검증, removed 멤버 즉시 차단) ② `x-ws-token`=**에이전트 토큰**(`wst_…`, 워크스페이스·역할 스코프) ③ 없으면 401. (레거시 공유 `AUTH_CLI_TOKEN`은 **제거됨** — env 에 다시 넣으면 되살아나지만 넣지 말 것.) `scripts/authz-coverage.test.ts`가 전 라우트의 requireCtx 채택을 정적 강제한다(새 라우트 추가 시 필수).
- 🔐 **fail-closed**(`middleware.ts`): UI는 미인증 시 `/login` 리다이렉트. `/api/*`는 세션 또는 `x-ws-token` 헤더 없으면 **항상 401**(과거의 "토큰 미설정 시 개방"은 제거, 데모용 `AUTH_OPEN_API=true`만 예외). `pnpm ws`는 `WS_TOKEN` env > `~/.claude/teamspace.json`(에이전트 토큰) 순으로 인증. 자체인증 경로(`/api/auth`·`/api/ingest`·`/api/slack/interactions`)는 제외.
- 🎭 **RBAC**: `viewer`(읽기) < `editor`(콘텐츠 쓰기) < `admin`(멤버·팀·워크스페이스 이름·슬랙·알림 규칙·에이전트 토큰). viewer 토큰으로 쓰기 호출하면 403.
- 🤖 **에이전트 토큰**(`/api/agent-tokens`, admin): `pnpm ws token add <name> [--role]` → `wst_…` 원문 1회 노출(저장 필수). 발급 시 에이전트가 시스템 User+멤버로 생성되어 작성자 기록·멤버 목록에 실명 표시. `token ls`/`token revoke <id>`(회수 시 멤버십도 removed). 설정 화면 › 에이전트 토큰 섹션에서도 발급/회수 가능. 에이전트마다 자기 토큰을 쓴다(공유 토큰 없음).
- 🚪 **로그인 접근 게이트**(`auth.ts` signIn 콜백 + `lib/accessControl.ts`): Google 로그인 자체를 두 경로로 제한 — **(a) 초대**: `/api/members`로 초대된(invited/active) 이메일, 또는 **(b) 도메인**: 이메일 도메인이 `AUTH_ALLOWED_DOMAINS`(콤마/공백 구분, `@` 선택) 에 포함. 둘 중 하나라도 만족하면 허용, 아니면 거부 → `/login?error=AccessDenied`(로그인 화면에 안내 배너). `AUTH_ALLOWED_DOMAINS` 미설정 시 (a) 초대 전용 모드. **주의: 게이트는 항상 활성** — 기존 active 멤버는 통과하나, 멤버도 허용 도메인도 아닌 계정은 차단된다(운영 도메인을 `AUTH_ALLOWED_DOMAINS`에 넣어 자기잠금 방지).
- 빌드 게이트: `pnpm exec tsc --noEmit && pnpm lint && pnpm test`.
- 백업: `pnpm backup` (pg_dump + docs/ tar → `~/Backups/teamspace/`, 최근 14개 로테이션). launchd `com.teamspace.backup`이 매일 03:30 자동 실행.
- 🚀 **배포(맥미니 상시)**: `pnpm deploy:local` = prod 빌드 + launchd 4종(web:3002·worker·backup·health) 설치·재기동. `GET /api/health`(무인증) = `{ok,db,worker}` — health 서비스가 5분마다 확인·자가복구. **3002는 프로덕션**(tailscale funnel로 `https://<your-host>` 공개) — 개발 서버는 `pnpm exec next dev -p 3003`. 코드 변경 반영은 재배포 필요. 로그: `~/Library/Logs/teamspace/`.

## 태스크 보드 (raw API)

보드는 `kind:"database"` 페이지, 행이 태스크. CLI: `pnpm ws board|task ...`.

1. 조회: `GET /api/databases/<boardId>` → `{ page, properties[], views[], rows[] }`. (보드 id는 `GET /api/pages`에서 `kind==="database"`.)
2. **속성 값 인코딩**(행 `row.props[propId]` 값 포맷 — 타입별로 다름):

   | 속성(기본 템플릿) | type | props 값 |
   |---|---|---|
   | 이름 | text | 문자열 |
   | 상태 | select | **옵션 id** (`config.options[].id`) |
   | 우선순위 | select | 옵션 id |
   | 담당자 | **text** | **문자열**(사람 id 아님) |
   | 마감일 | date | `YYYY-MM-DD`/ISO 문자열 |

3. 상태 변경: `PATCH /api/rows/<rowId>` `{ "props": { "<statusPropId>": "<optionId>" }, "expectedUpdatedAt"?, "contentPageId"? }` (props는 **병합**). `expectedUpdatedAt`(opt-in, 행의 `updatedAt` ISO)이 다르면 **409 + 현재 행 반환**. `contentPageId`=태스크↔문서 연결(null=해제, CLI `task link`). 모든 변경은 액터(updatedById)가 기록된다.
4. 행 추가: `POST /api/databases/<boardId>/rows` `{ "props": {...} }`. 삭제: `DELETE /api/rows/<rowId>`.
5. **재정렬**: `PATCH /api/rows/<rowId>` `{ "position": <number> }`.
5-1. **원자적 클레임**: `POST /api/rows/<rowId>/claim` `[{force:true}]` → 담당자 비어 있을 때만 CAS 로 `담당자=현재 액터, 상태=진행 중`. 경쟁/이미 할당이면 **409+현재 담당자**. **에이전트는 태스크를 잡을 때 반드시 claim 을 쓴다**(PATCH 로 담당자 직접 쓰기 금지 — 이중 작업 방지). CLI: `task claim <rowId> [--force]`, 내 태스크: `task mine` / `GET /api/tasks?assignee=me[&board=]`.
6. 보드 새로 생성: `POST /api/databases` `{ "title"?, "parentId"?, "projectId"? }`(projectId=프로젝트에 연결) → 위 4속성(상태: 할 일/진행 중/완료, 우선순위: 낮음/보통/높음)·뷰(표/보드)가 갖춰진 보드. 단순 목록: `GET /api/tasks` → `{ tasks:[{id,title,due,status}], databaseId }`.

7. **체크리스트**(행별): `GET/POST /api/rows/<rowId>/checklist` `{ text }` · `PATCH/DELETE /api/rows/<rowId>/checklist/<itemId>` `{ done?, text? }`.
8. **댓글**(행별): `GET/POST /api/rows/<rowId>/comments` `{ body }`(작성자=현재 사용자). 태스크 상세 드로어의 체크리스트/댓글 탭이 이걸 사용.

> **속성/옵션 API**(W5): `POST /api/databases/<id>/properties {name,type,config?}` · `PATCH .../properties/<propId> {name?, addOption:{name,color?}, renameOption:{id,name}}` · `DELETE`. CLI: `board prop add|opt|rm`. 뷰 변경 API는 아직 없음. · 칸반: `/p/<boardId>?view=kanban`, 테이블: `?view=table`.

## 문서 (file-first)

CLI: `pnpm ws doc new|save|cat|rm|rename|mv|backlinks`. raw API:

- 목록: `GET /api/pages`(doc=`kind:"doc"`). 본문: `GET /api/pages/<id>` → `{ page(rev 포함), markdown }`.
- 생성: `POST /api/pages` `{ "title", "kind":"doc", "projectId"?, "parentId"? }`. **폴더 = 자식을 가진 doc 페이지**(별도 타입 없음) — `parentId`로 중첩하면 사이드바에서 📁로 표시.
- 본문 저장: `PUT /api/pages/<id>` `{ "markdown", "title"?, "baseRev"? }` → doc은 `docs/<프로젝트>/<제목>.md`로 기록(file-first). **markdown 없이 호출하면 제목만 갱신(본문 보존)**. `baseRev`(opt-in, GET의 `page.rev`)가 서버와 다르면 **409 + 현재 상태 반환** — 에이전트는 재조회 후 병합 저장. 저장마다 rev+1 되고 버전이 적재된다.
- **버전 히스토리**: `GET /api/pages/<id>/revisions`(목록, `?rev=<n>`=본문 포함 단건) · `POST /api/pages/<id>/revisions {rev}`(복원 — 새 리비전으로 적재). CLI: `doc history <id> [--rev n]`, `doc restore <id> --rev n`. UI: 문서 리더 "히스토리" 패널.
- 메타 변경: `PATCH /api/pages/<id>` `{ projectId?, title?, icon?, parentId? }` — 주어진 필드만 갱신. `projectId`(null=미분류) · `title`(이름변경) · `parentId`(폴더 이동, 자기 자신/자손으로의 이동은 400 거부). CLI: `doc rename <id> <title>`, `doc mv <id> [--parent <id>] [--project <id>]`.
- 삭제: `DELETE /api/pages/<id>` — **휴지통으로 소프트 삭제**(md 파일 보존). 자식 있으면 409, `?recursive=1`=서브트리 일괄. **휴지통**: `GET /api/trash` · `POST /api/trash/<id>`(복원) · `DELETE /api/trash/<id>`(영구 삭제 — 이때만 파일 제거). CLI: `doc rm <id> [--recursive]`, `trash ls|restore|purge`. UI: 설정 › 휴지통.
- **위키링크**: 본문 `[[문서 제목]]` 자동 링크. 백링크: `GET /api/pages/<id>/backlinks`.
- 보드 화면 헤더의 프로젝트 셀렉트, 사이드바의 폴더/문서 드래그·이름변경·삭제가 모두 위 PATCH/DELETE 사용.
- ⚠️ 정리/삭제는 가능하면 soft-delete(`Page.deletedAt`), `.md` 파일 보존.

## 프로젝트 / 멤버 / 워크스페이스

- 프로젝트: `GET/POST /api/projects` `{ name, short?, color?(blue/orange/purple/green/red/gray), description?, leadId?, repoUrl?, repoPath?, repoBranch?, docsDir? }` · `PATCH/DELETE /api/projects/<id>`.
- 멤버(초대): `GET/POST /api/members` `{ email, role?(admin/editor/viewer, 기본 editor) }`(이메일로 User find-or-create, 이미 멤버면 409). **POST는 `status:"invited"`로 추가** — 해당 사용자가 로그인하면 `getContext`가 자동으로 `active`로 수락. `PATCH /api/members/<id> {role?, teamId?}`(teamId=null이면 팀 해제) · `DELETE` — **마지막 admin 강등/제거는 차단**(400).
- 팀: `GET/POST /api/teams` `{ name, color?(blue/orange/purple/green/red/gray) }`(GET은 memberCount 포함) · `PATCH /api/teams/<id> {name?, color?}` · `DELETE`(멤버 teamId는 SetNull로 해제). 멤버 배정은 위 `PATCH /api/members/<id> {teamId}`.
- 현재 워크스페이스: `GET /api/workspace` → `{ workspace, role, me, memberCount }` · `PATCH {name}`(admin만, 아니면 403).
- **멀티 워크스페이스**(`pnpm ws workspace …`): `GET /api/workspaces` → `{ workspaces:[{id,name,role,memberCount,current}] }`(내가 속한 active 워크스페이스, `current`=활성) · `POST /api/workspaces {name}`(생성자=admin·active, 생성 후 `ws_active` 쿠키로 전환) · `POST /api/workspaces/switch {workspaceId}`(active 멤버십 검증 → `ws_active` httpOnly 쿠키 설정, 비멤버는 403). 활성 워크스페이스는 `ws_active` 쿠키가 결정(없으면 첫 워크스페이스). 설정 화면(설정 › 워크스페이스 전환)에서도 전환·생성 가능.

## 문서 허브 surface (모두 같은 패턴: GET 목록 / POST 생성 / [id] PATCH·DELETE)

| 종류 | 엔드포인트 | 핵심 필드 | 목록 키 |
|---|---|---|---|
| 결정 | `/api/decisions` | title, context?, decision?, status(proposed/accepted/superseded), projectId? | decisions |
| 리스크 | `/api/risks` | title, description?, severity(low/medium/high), status(open/mitigated/closed), projectId? | risks |
| QA | `/api/qa` | title, steps?, expected?, status(pending/pass/fail), projectId? | scenarios |
| 용어집 | `/api/glossary` | term, definition, sourcePageId?(provenance) | terms |
| 변경이력 | `/api/changelog` | version?, title, body? | entries |
| 데이터모델 | `/api/entities` | name, description?, fields?, sourcePageId?(provenance) | entities |
| DoD | `/api/dod` | text / `[id]` PATCH `{done}` 토글 | items |
| 온보딩 | `/api/onboarding` | title, body? | steps |

- 필터: `/api/decisions·risks·qa` 는 `?projectId=<id>` 지원. `/api/schedules` 는 `?databasePageId=<id>`.
- **추출→병합 제안**(B2 추출 파이프라인): 문서 본문을 LLM(`lib/llm.complete`)으로 추출해 기존과 대조한 제안을 반환(**자동 기록 안 함**, 검토 단계). 순수 로직 `lib/extract.ts`. LLM 미설정 시 503.
  - 용어: `POST /api/glossary/extract {pageId}` → `{ ok, sourcePageId, proposals:[{term,definition,status(new|duplicate|conflict),existingId?,existingDefinition?}] }`. 수락 `POST /api/glossary {term,definition,sourcePageId}`. `pnpm ws glossary extract <pageId>`. 용어집 화면 "문서에서 추출".
  - 엔티티: `POST /api/entities/extract {pageId}` → `proposals:[{name,description,fields,status,existingId?,existingDescription?}]`. 수락 `POST /api/entities {name,description?,fields?,sourcePageId}`. `pnpm ws entity extract <pageId>`. 데이터모델 화면 "문서에서 추출".
- **provenance 태깅**(주장 신뢰도, 키리스): `POST /api/provenance {pageId}` → 로컬 LLM 으로 문서의 핵심 주장을 **추출/추론/모호**로 분류 → `{ ok, claims:[{claim,tag,note}], counts:{추출,추론,모호} }`. 순수 로직 `lib/provenance.ts`(buildProvenancePrompt·parseProvenance·countTags). `pnpm ws provenance <pageId>`. LLM 미설정 시 503. 문서 리더의 "신뢰도 분석" 패널.
- **웹 클리퍼**(키리스 자동 분류·요약): `POST /api/clip {url, title?, text, html?}` → 로컬 LLM 으로 본문 요약 + 기존 프로젝트 자동 분류 → 출처 포함 doc 페이지 생성(분류된 projectId 배정) → `{ ok, pageId, projectId, projectName, summary, mode("classified"|"plain") }`. LLM 없으면 원문만 저장(plain). 순수 로직 `lib/clip.ts`(buildClassifyPrompt·parseClassification). `pnpm ws clip <url> --text "<본문>" [--title <t>]`. 브라우저 진입점은 북마클릿(`/clip` 페이지로 수집 데이터 전달, 동일 출처 POST).
- 부가: `GET /api/graph`(위키 그래프) · `GET /api/lint`(깨진 링크·고아) · `GET /api/search?q=`.
- **비동기 LLM 잡**(범용 큐, editor 이상): `POST /api/llm/classify {kind, payload, callbackUrl, callbackSecret?}` → 즉시 `202 {jobId}`, 실제 처리는 워커(`dispatchLlmJobs`, `lib/llmjob.ts`)가 맡아 완료 후 `callbackUrl` 로 `{jobId,kind,ref,ok,result}` POST(Bearer `callbackSecret`, 있으면). 현재 지원 kind: `feedback_classify`(`payload:{ref,body,agendas:[{id,title,summary?}]}`). `pnpm ws llm classify --body <텍스트> --callback <url>`(디버그용 최소 명령 — callback 필수, 결과가 원문 포함으로 그 URL에 POST되므로 신뢰할 수 있는 수신처만).

## MCP 서버 (W8 — 네이티브 접점)

- **이 레포의 `.mcp.json`이 `teamspace` MCP 서버를 자동 등록** — context_get·task_list/claim/add/update·board_get·doc_list/read/save/create/comment·lesson_list/add·decision_add·inbox_list·activity_list·search 툴 제공(`scripts/mcp-server.ts`). 다른 레포/머신: `claude mcp add teamspace -- pnpm --dir <레포경로> exec tsx scripts/mcp-server.ts`. 인증은 `~/.claude/teamspace.json`.
- MCP 툴이 있으면 그걸 우선 사용, 없으면 이 스킬의 CLI/raw API 로.
- **멱등성(W8)**: rows·pages·schedules·approvals·comments POST 는 `Idempotency-Key` 헤더 지원 — 재시도 시 같은 키를 보내면 이중 생성 없이 저장된 응답 반환.
- **이벤트 푸시(W8)**: `GET /api/events` SSE(브라우저 쿠키 전용) — UI 자동 갱신이 이벤트 기반. 에이전트는 폴링/MCP 유지.
- **토큰 체인(W8)**: ws CLI·훅·MCP 모두 `WS_TOKEN` > `~/.claude/teamspace.json`. 레거시 공유 토큰은 폐기 완료 — 항상 에이전트 토큰(wst_)만 쓴다. 새 에이전트/머신은 `pnpm ws token add <이름>` 발급 후 teamspace.json 에 저장.

## Claude가 워크스페이스를 읽기 (AI 연결)

- `GET /api/context?format=md|json&cwd=<path>` → 워크스페이스를 **Claude가 읽는 Markdown 스냅샷**으로(**팀 레슨**·보드 열린 태스크·문서·승인된 결정·열린 리스크·용어집). `cwd`를 주면 라우트룰로 프로젝트를 해석해 그 프로젝트 우선 필터. `format=json`은 `{ markdown, counts }`. `pnpm ws context`.
- **자동 주입(W3)**: SessionStart 훅(`scripts/hooks/teamspace-context.mjs`, 전역 사본 `~/.claude/hooks/`)이 매 세션 시작 시 위 스냅샷을 주입하고 세션 시작을 `/api/ingest`에 기록, SessionEnd 훅이 종료를 기록한다. 인증은 `~/.claude/teamspace.json` `{base, token}`(에이전트 토큰) — 팀원 머신도 같은 파일로 참여.
- **레슨(팀 작업규칙)**: `GET/POST /api/lessons {title, body, projectId?}` · `PATCH/DELETE /api/lessons/<id>`. CLI: `pnpm ws lesson add|ls|rm`. UI: 문서 허브 › 팀 작업규칙 탭. 컨텍스트 주입 최상단에 포함되므로 "팀원 전원의 에이전트가 알아야 할 규범"은 반드시 레슨으로 승격.
- **승격 제안 큐**: `GET/POST /api/proposals {kind(lesson|decision), title, body, projectId?}` · `PATCH /api/proposals/<id> {action: approve|reject, note?}`(admin — approve 시 레슨/결정 자동 생성) · `DELETE`(본인 pending 철회). CLI: `proposal ls|add|approve|reject`. MCP: `propose`. **세션에서 배운 팀 규범·확정 사항은 세션이 끝나기 전에 lesson_add(확신+admin) 또는 propose(검토 필요)로 남긴다** — admin에게 인앱 알림, 결과는 제안자에게 알림. UI: 팀 작업규칙 탭 상단 대기 목록.
- **라우트룰(cwd→프로젝트)**: `GET /api/route-rules {cwdPrefix, projectId?, priority?}`(인증만) · `POST`(**editor** — 설치기 재실행이 페어링 발급 editor 토큰으로 호출하므로 admin→editor 완화) · `DELETE /api/route-rules/<id>`(admin 유지). CLI: `pnpm ws route-rule add|ls|rm`.
- AI 연결 화면(`/aiconnect`)이 이 스냅샷 미리보기·복사·`.md` 내보내기 + 연결 방법(이 스킬·`pnpm ws`·읽기 API·file-first `docs/*.md`)을 보여준다. 세션 탐색기(M4 `/api/sessions`·`/api/ingest`)는 보조.
- **Vault Q&A**: `GET /api/ask?q=<질문>` → 문서·결정 본문에서 근거 패시지를 찾아 답한다. `{ question, answer, mode("llm"|"extractive"|"empty"), sources:[{id,title,kind(doc|decision),passage,heading}] }`. 랭킹 순수로직 `lib/ask.ts`(tokenize·scorePassage·rankSources), 합성 `lib/llm.ts`. UI: 검색 화면의 "물어보기" 토글. `pnpm ws ask "<질문>"`.
  - **개념 검색**(임베딩 없이 키리스): `GET /api/search/concept?q=` → 로컬 LLM(`lib/llm.complete`)으로 검색어를 동의어·연관 개념으로 확장한 뒤 합집합 토큰으로 본문 검색·랭킹 → `{ query, expanded[], terms[], mode("expanded"|"plain"), results:[{id,title,kind,passage,heading}] }`. LLM 없으면 원 토큰만(plain)으로 graceful. 순수 로직 `lib/semsearch.ts`(parseExpansion·mergeTerms). `pnpm ws concept "<검색어>"`. (진짜 벡터 임베딩 B4 는 외부 임베딩 API 필요 — 이건 그 키리스 대안.)
  - **LLM 프로바이더**(`ASK_LLM_PROVIDER`=api|cli|off, 기본 자동): `api`=`ANTHROPIC_API_KEY`로 Anthropic API(모델 `ANTHROPIC_MODEL` 기본 sonnet-4-6). `cli`=**키 없이** 로컬 `claude` CLI 헤드리스(`-p`, 툴 비활성·1턴, 모델 `ASK_CLAUDE_MODEL` 기본 haiku-4-5, 타임아웃 `ASK_CLAUDE_TIMEOUT_MS` 기본 30s)로 기존 Claude Code 로그인 사용. 자동 결정: 키 있으면 api, 없으면 cli(바이너리 부재 시 추출형 폴백). 어느 경로든 실패하면 `mode=extractive` 발췌로 안전 폴백.

## 협업 (W6): 인박스 · 활동 피드 · 코멘트 · 업로드

- **알림 인박스**: `GET /api/notifications[?unread=1]` · `PATCH /api/notifications/<id> {read}` · `POST /api/notifications {readAll:true}`. 적재 시점: 태스크 배정(담당자 이름→멤버 매칭)·@멘션·승인 요청(admin들)·마감. UI `/inbox`(사이드바 미읽음 배지), CLI `inbox ls [--unread]`/`inbox read [id]`.
- **활동 피드(경량 감사로그)**: 문서·태스크·결정·승인·업로드 행위가 Activity 로 기록. `GET /api/activity?limit=&type=&actor=`, CLI `activity ls`, 대시보드 "최근 활동" 패널(에이전트 실명 표시).
- **문서 코멘트**: `GET/POST/DELETE(?commentId=) /api/pages/<id>/comments {body}` — 본문 `@이름` 은 멤버 매칭되어 인앱 알림 + comment_added 규칙 발화. 문서 리더 하단 코멘트 섹션, CLI `doc comment <pageId> --body`.
- **파일 업로드**: `POST /api/upload` (multipart `file`, 20MB) → `{url, markdown}` — public/uploads/<ws>/ 로컬 저장, 반환 마크다운을 문서에 붙여 사용.
- **자동 갱신**: 보드·문서 목록·대시보드·인박스는 30초 폴링+창 포커스 시 refetch(`lib/useAutoRefresh`). 푸시(SSE)는 W8.
- **의존관계(최소)**: `pnpm ws task block <rowId> --by <선행rowId>` — "선행 태스크"(relation) 속성을 자동 생성해 rowId 배열로 기록(컨벤션).

## 승인 / 리마인더 / 슬랙 / 세션

- 승인: `POST /api/approvals` `{ title, body, kind?(general/status/triage/doc/project/deploy), highRisk?, channel?, projectId? }` → 발송 시 디자인시스템 카드(액센트 바·kind/위험 배지·요청자/프로젝트/시각 메타)로 전송, 결정 시 결과 카드로 치환. CLI: `pnpm ws approval add <title> --body <b> [--kind <k>] [--high] [--channel <id>] [--project <projectId>]`. `PATCH /api/approvals/<id>` `{ status(approved/rejected/additional), responseText? }` — **이미 결정된 승인은 409**(앱·슬랙 공통, W8), 결정자(respondedBy) 기록.
- 리마인더: `POST /api/schedules` `{ remindAt(ISO/datetime-local), text, channelId?, databasePageId? }` · `DELETE /api/schedules/<id>`. 채널 우선순위: 명시 channelId > 기본 채널 — 기본 채널은 `PATCH /api/slack {defaultChannelId}` 로 저장(env 토큰 모드도 지원, .env 수정 불필요) 또는 `AUTH_SLACK_DEFAULT_CHANNEL` env. 전부 없으면 failed. **워커(launchd `com.teamspace.worker`)가 상시 디스패치 중**(60초 폴링). **반복 리마인더(W7)**: `{repeat:"daily"|"weekly:MON", time:"HH:MM"}` → kind=cron, 발송 후에도 active 유지. CLI: `remind add --every daily --time 09:00`.
- 예약 디스패치(워커): `POST /api/cron/tick` → 만기 `once` 스케줄을 스캔해 Slack 발송 후 `done/failed` 마킹 → `{ checked, sent, failed, ids }`. `GET /api/cron/tick` → `{ active, due }`(부수효과 없음). `pnpm ws tick`(`--preview`=GET). 상시 처리는 **워커 컨테이너** `pnpm worker`(DB 폴링, `WORKER_INTERVAL_MS` 기본 60초; `docker compose --profile worker up -d --build worker`). 로직은 `lib/dispatch.ts`(`selectDueOnce` 순수함수 + `dispatchDue`), 외부 cron 은 `x-ws-token` 으로 `/api/cron/tick` POST. (BullMQ+redis 대신 DB 폴링 — redis 는 compose 에 있고 분산 재시도 필요 시 후속 업그레이드.)
- 슬랙: `GET/PATCH/DELETE /api/slack`, `POST /api/slack/connect {token}`, `POST /api/slack/test`. 토큰은 `AUTH_SLACK_BOT_TOKEN` env 우선, 없으면 DB. 슬랙 인터랙션 콜백: `POST /api/slack/interactions`.
- 발송 내역: `GET /api/slack/log?kind=&limit=` → `{ logs[], total, failed, sentToday }`. `postMessage`/`sendApproval` 발송 시 `NotifLog`에 자동 기록(kind: manual/approval/reminder/test/notification). 슬랙 화면 '알림 발송 내역' 섹션·대시보드 '오늘 보낸 알림'에서 사용.
- 채널 목록: `GET /api/slack/channels` → `{ ok, channels:[{id,name}], error? }`(공개 채널, `channels:read` 스코프 필요). 슬랙 화면 채널 입력의 피커(datalist)·`pnpm ws slack channels`.
- 자동 알림 규칙: `GET/POST /api/notif-rules` `{ event(task_created/task_status/task_assigned/task_due), targetId(채널), projectId?(프로젝트 스코프, 없으면 전역) }` · `PATCH /api/notif-rules/<id> {enabled}` · `DELETE`. **4개 이벤트 전부 실발화**(W5): 생성(rows POST)·상태 변경(rows PATCH)·담당자 변경(PATCH·claim)·마감(워커 일일 스캔, `due_marker`로 하루 1회 중복 방지). dm 타깃은 미지원(400). **매칭 우선순위: 프로젝트 규칙 우선, 없으면 전역**. CLI: `pnpm ws notif-rule add <event> <channel> [--project <projectId>]`. 슬랙 화면 '자동 알림 규칙' 섹션.
- 세션(M4): `POST /api/ingest`(HMAC 또는 **에이전트 토큰**) → `GET /api/sessions`, `/api/sessions/<id>`. items 의 `externalRef` 는 중복 적재 스킵(멱등). **active 세션이 24h 무동기면 워커가 ended 처리**(W8). 세션 종료 훅이 팀 프로젝트 cwd 에 한해 요약 메타(첫 프롬프트 1줄·관찰 수)만 적재 — 관찰 원문은 로컬(agentmemory)에만.
- 슬랙 컨펌 발송/수신 스크립트: `scripts/slack-confirm.ts`(`#workspace-confirm`).

## 새 머신 부트스트랩(curl|sh)

새 맥/서버에 에이전트 환경을 세팅할 때 한 줄로 페어링→토큰 발급→route-rule 등록까지 끝낸다.

```bash
curl -fsSL https://<your-host>/setup.sh | sh -s -- https://<your-host>
```

플로우:

1. 설치 스크립트가 페어링 코드를 발급하고 브라우저를 `/setup/pair?code=<code>` 로 연다 → 사용자가 Google 로그인으로 승인.
2. 스크립트는 `GET /api/pair/<code>` 를 폴링해 로그인 완료 시 발급되는 에이전트 토큰(`wst_…`)을 받는다(페어링 코드 자체가 인증 — 별도 헤더 불필요).
3. 로컬에서 프로젝트(클론 대상)를 선택하고, cwd→프로젝트 매핑을 등록한다 — 최초 등록은 `POST /api/pair/<code>/route-rule`(페어링 게이트), 이미 페어링이 만료된 뒤 스크립트를 **재실행**할 때는 발급받은 `x-ws-token`(editor)으로 `POST /api/route-rules` 를 직접 호출.
4. 전역 훅(`GET /setup/hooks/<name>.mjs` — SessionStart/End 등, 화이트리스트된 이름만 공개 서빙)과 필요한 플러그인을 내려받아 `~/.claude/hooks/`·`~/.claude/teamspace.json` 에 설치한다.

엔드포인트(부트스트랩 전용, 화이트리스트는 `scripts/ws.test.ts` `REVERSE_WHITELIST` 참고 — CLI 명령이 아니라 브라우저/설치기 자체인증 플로우라 `pnpm ws` 로 감싸지 않는다):

| 엔드포인트 | 인증 | 역할 |
|---|---|---|
| `POST /api/pair/approve` | 브라우저 로그인 세션 | 페어링 코드 승인(사용자가 `/setup/pair?code=` 에서 클릭) |
| `GET /api/pair/[code]` | 페어링 코드 자체인증 | 설치 스크립트가 폴링해 토큰 수령 |
| `POST /api/pair/[code]/route-rule` | 페어링 코드 자체인증(만료 전) | 최초 설치 시 cwd→프로젝트 매핑 등록 |
| `GET /setup.sh`(`/api/setup/script`) | 없음(공개 정적) | curl 설치기 스크립트 서빙 |
| `GET /setup/hooks/[name]`(`/api/setup/hooks/[name]`) | 없음(화이트리스트된 name만 공개 정적) | 전역 훅 파일 서빙 |

## 주의

- 순수 로직은 TDD(`lib/*.test.ts`, vitest), 라우트/UI는 브라우저 검증이 이 레포 방침.
- 새 API/화면은 기존 `app/api/*/route.ts`·`components/ws/*` 패턴을 따른다(`runtime="nodejs"`, `@/lib/prisma`, `@/lib/workspace`).
- 디자인 동기화 기준: `docs/teamspace/DESIGN-SYNC.md`.
- **이 스킬·CLI를 최신으로**: `app/api` 라우트나 워크스페이스 데이터 기능을 추가/변경하면 **같은 커밋에서 이 SKILL.md + `scripts/ws.ts`(필요시 `scripts/ws.test.ts`)를 함께 갱신**한다(AGENTS.md 규칙). 패리티 테스트가 깨지면 동기화가 빠진 것이다.
