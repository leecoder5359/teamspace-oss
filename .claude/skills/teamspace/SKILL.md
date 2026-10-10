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

명령 그룹: `board · task · doc · project · decision · risk · qa · glossary · changelog · entity · onboarding · dod · approval · remind · member · team · token(에이전트 토큰) · ws(info/rename) · search · lint · graph · llm(classify) · sessions(live) · lock(take/extend/release/ls/notify/install-hook)`. 각 명령은 내부적으로 아래 라우트를 호출한다 — CLI가 못 덮는 케이스나 디버깅 때만 raw API를 직접 쓴다. `scripts/ws.test.ts` 가 패리티를 검증한다 — 명령↔라우트 존재뿐 아니라 **HTTP 메서드(GET/POST/PATCH/DELETE)와 CLI 가 보내는 body 키가 라우트에 실재하는지**까지 본다(2026-08-07 강화. 그 전엔 존재만 봐서 set 계열 7개가 405/400 으로 죽어 있는 걸 못 잡았다).

## 핵심 규칙 (CLI든 raw API든 공통)

- 새 문서는 `--folder` 로 폴더를 지정한다(MCP `doc_create` 도 `folder`·`docType`). 태스크 설명은 `--type task_note`. 프로젝트 뿌리에 바로 두면 위키 점검에 "폴더 밖 문서" 경고가 뜬다.
- 상태/선택 옵션 ID는 워크스페이스마다 다르다 → **하드코딩 말고 항상 조회해서 매핑**(CLI는 이름으로 자동 매핑: `--status "진행 중"`).
- 모든 라우트는 `requireCtx(minRole?)`(lib/workspace.ts)로 컨텍스트+RBAC 해석: ① 세션(매 요청 멤버십 검증, removed 멤버 즉시 차단) ② `x-ws-token`=**에이전트 토큰**(`wst_…`, 워크스페이스·역할 스코프) ③ 없으면 401. (레거시 공유 `AUTH_CLI_TOKEN`은 **제거됨** — env 에 다시 넣으면 되살아나지만 넣지 말 것.) `scripts/authz-coverage.test.ts`가 전 라우트의 requireCtx 채택을 정적 강제한다(새 라우트 추가 시 필수).
- 🔐 **fail-closed**(`middleware.ts`): UI는 미인증 시 `/login` 리다이렉트. `/api/*`는 세션 또는 `x-ws-token` 헤더 없으면 **항상 401**(과거의 "토큰 미설정 시 개방"은 제거, 데모용 `AUTH_OPEN_API=true`만 예외 — **production 빌드에서는 true 여도 무시**된다). `pnpm ws`는 `WS_TOKEN` env > `~/.claude/teamspace.json`(에이전트 토큰) 순으로 인증. 자체인증 경로(`/api/auth`·`/api/ingest`·`/api/slack/interactions`)는 제외.
- 🛡 **CSP 위반 수집**: 전역 `Content-Security-Policy-Report-Only` 에 `report-uri /api/csp-report` + `report-to csp-endpoint`(`Reporting-Endpoints` 헤더). `POST /api/csp-report` 는 **무인증**(브라우저가 자격 증명 없이 보냄) — 본문 2KB 상한(초과 413)·미들웨어 IP 당 1/분(`csp` 정책, 초과 429)·저장 없이 `warn csp.violation`(directive·blocked·document, 쿼리 제거)만 로그·항상 204. CLI 명령 없음(브라우저 전용).
- ⏱ **레이트 리밋**(`middleware.ts`, 인메모리·단일 프로세스): 로그인 signin/callback 20/분(IP)·`/api/ask` 10/분·`/api/search*` 60/분·`/api/csp-report` POST 1/분(IP)·`/api/site-intake` POST 10/분(/pub 프록시 서명이 있으면 사이트·게스트별, 없으면 IP)·`/api/pair/<코드>` GET **코드별(IP+페어링 코드) 60/분 + IP 합산 240/분**(설치기 2초 폴링 여유; IP 합산을 먼저 세고 거절되면 코드별 버킷은 소모하지 않는다. 한 IP 에서 코드 5개 이상을 동시에 폴링하면 합산에 닿는 것은 수용한 한도다). `u:`(로그인 사용자)·`site:`(게스트) 키 클래스는 상한 없이 키 수만 제한 — 의도된 설계. 초과 시 **429 `{error:"rate_limited", retryAfterSec}` + `Retry-After` 헤더 — Retry-After 초 뒤 재시도**한다(즉시 재시도 루프 금지). IP 는 `x-forwarded-for` **가장 오른쪽** 값(가장 가까운 프록시가 붙인 홉) → `x-real-ip` 순. `x-ws-token` 은 `wst_<64hex>` 형식일 때만 버킷 키로 쓰고(위조 토큰 회전 방지) 아니면 IP 키. 키 수는 토큰 2,000·IP 8,000 상한이고 가득 차면 먼저 다 리필된 가장 오래된 버킷의 슬롯을 회수하고, 전부 활성일 때만 새 키가 클래스 공용 overflow 버킷을 나눠 쓴다. 페어링 코드는 32자 소문자 hex 일 때만 코드별 키(형식 불량·`/api/pair/approve` 는 IP 키). 로컬·테스트는 `RATE_LIMIT=off` 로 끈다.
- 🎭 **RBAC**: `viewer`(읽기) < `editor`(콘텐츠 쓰기) < `admin`(멤버·팀·워크스페이스 이름·슬랙·알림 규칙·에이전트 토큰). viewer 토큰으로 쓰기 호출하면 403.
- 🔒 **페이지·프로젝트 권한(D3)**: 역할만으로 끝나지 않는다 — 멤버여도 **못 보는 페이지가 있다**. 아래 "공유 범위" 절 참고. 에이전트 토큰은 보통 `editor` 라, 비공개 페이지에 대해 `pnpm ws doc rm` 같은 명령이 **404** 를 받는 것이 정상이다(권한 없음이 아니라 '없는 것처럼' 보이는 설계).
- 🤖 **에이전트 토큰**(`/api/agent-tokens`, admin): `pnpm ws token add <name> [--role]` → `wst_…` 원문 1회 노출(저장 필수). 발급 시 에이전트가 시스템 User+멤버로 생성되어 작성자 기록·멤버 목록에 실명 표시. `token ls`/`token revoke <id>`(회수 시 멤버십도 removed). 설정 화면 › 에이전트 토큰 섹션에서도 발급/회수 가능. 에이전트마다 자기 토큰을 쓴다(공유 토큰 없음). 이름 `legacy-cli`(공백·대소문자 무시)는 부트스트랩 ctx 표시명이라 예약 — 발급 시 400.
- 🚪 **로그인 접근 게이트**(`auth.ts` signIn 콜백 + `lib/accessControl.ts`): Google 로그인 자체를 두 경로로 제한 — **(a) 초대**: `/api/members`로 초대된(invited/active) 이메일, 또는 **(b) 도메인**: 이메일 도메인이 `AUTH_ALLOWED_DOMAINS`(콤마/공백 구분, `@` 선택) 에 포함. 둘 중 하나라도 만족하면 허용, 아니면 거부 → `/login?error=AccessDenied`(로그인 화면에 안내 배너). `AUTH_ALLOWED_DOMAINS` 미설정 시 (a) 초대 전용 모드. **계정 자동 연결**: 초대(멤버·퍼블리시 게스트)·시드는 User 행을 로그인 전에 만들기 때문에 Google 에 `allowDangerousEmailAccountLinking` 을 켰다 — 안 켜면 첫 로그인이 `OAuthAccountNotLinked`("로그인 중 문제가 발생했어요")로 막힌다(2026-09-14 발견). 대신 signIn 콜백이 `profile.email_verified === true` 를 강제한다(`isVerifiedOAuthEmail`). **주의: 게이트는 항상 활성** — 기존 active 멤버는 통과하나, 멤버도 허용 도메인도 아닌 계정은 차단된다(운영 도메인을 `AUTH_ALLOWED_DOMAINS`에 넣어 자기잠금 방지).
- 📥 **본문 모양 오류는 400**: 쓰기 라우트(보드·행·페이지와 지식·관리 라우트 — decisions·lessons·approvals·risks·qa·dod·glossary·entities·onboarding·changelog·proposals·projects·members·teams·notif-rules·notifications·workspace(s)·route-rules·schedules·agent-tokens·sites·clip·provenance·extract·llm/classify)는 본문을 zod 로 검증한다. 깨진 JSON 은 `{error:"본문이 올바른 JSON 이 아닙니다."}`, 필드 타입이 틀리면(문자열 자리에 숫자·배열, null 불허 필드에 null 등) `{error:"입력값이 올바르지 않습니다.", issues:[{path,message}]}` 로 400 이다. 빈 본문은 `{}` 로 보고, 스키마에 없는 필드는 무시한다. DB 열거형으로 바로 저장되는 값(예: approvals `kind`)은 스키마가 검사해 모르는 값도 같은 400 `{error, issues}` 다. 그 밖의 상태값 일부는 라우트가 기존 문구로 따로 검사한다.
- 빌드 게이트: `pnpm exec tsc --noEmit && pnpm lint && pnpm test`.
- 백업: `pnpm backup` (pg_dump + docs/ tar → `~/Backups/teamspace/`, 최근 14개 로테이션). launchd `com.teamspace.backup`이 매일 03:30 자동 실행.
- 🚀 **배포(맥미니 상시)**: `pnpm deploy:local` = prod 빌드 + launchd 4종(web:3002·worker·backup·health) 설치·재기동. `GET /api/health`(무인증) = `{ok,db,worker}` — health 서비스가 5분마다 확인·자가복구. **3002는 프로덕션**(tailscale funnel로 https://teamspace.example.com 공개; web 서비스는 `-H 127.0.0.1` 로 **루프백에만** 바인딩 — LAN/공인 IP 로 직접 접근 불가, rate limit 은 funnel 이 붙이는 X-Forwarded-For 가장 오른쪽 값을 신뢰, 결정 cmv0jbu6z) — 개발 서버는 `pnpm exec next dev -p 3003`. 코드 변경 반영은 재배포 필요. 로그: `~/Library/Logs/teamspace/`.

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
5. **재정렬**: `PATCH /api/rows/<rowId>` `{ "position": <number> }`. `position` 은 0 이상 정수여야 하고, 잘못된 모양의 본문(position null·문자열·음수·소수, 깨진 JSON 등)은 400 + `{error, issues:[{path,message}]}` 이다.
5-1. **429 재시도**: CLI·MCP 는 `429`+`Retry-After`(초/HTTP-date)면 최대 10초 기다려 1회만 재시도. **원자적 클레임**: `POST /api/rows/<rowId>/claim` `[{force:true}]` → 담당자 비어 있을 때만 CAS 로 `담당자=현재 액터, 상태=진행 중`. 경쟁/이미 할당이면 **409+현재 담당자**. **에이전트는 태스크를 잡을 때 반드시 claim 을 쓴다**(PATCH 로 담당자 직접 쓰기 금지 — 이중 작업 방지). CLI: `task claim <rowId> [--force]`, 내 태스크: `task mine [--limit n|--all]`(끝에 `총 N건 (표시 M)`) / `GET /api/tasks?assignee=me[&board=]`.
5-2. **다른 보드로 이동**: `POST /api/rows/<rowId>/move` `{ targetDatabaseId, dryRun?, createMissingOptions?, expectedUpdatedAt? }` (editor, 원본·대상 보드 **둘 다 edit**). **같은 행(id 그대로)** 의 `databasePageId` 를 바꾸므로 코멘트·체크리스트·문서 연결(contentPageId)·작성자·활동이 따라간다. 대상 보드 맨 끝(position)으로 가고 `parentRowId` 는 null. 응답 `{ ok, dryRun, row?:{id,databasePageId}, mapped:[{name,type,to?}], dropped:[{name,type,reason,value}], createdOptions:[{property,option}], referencedBy }`(`createdOptions` 는 실제로 새로 만든 옵션만 담는다 — 동시에 다른 요청이 먼저 같은 이름을 만들었으면 그 요청은 재사용만 하고 여기 나오지 않는다). CLI: `task transfer <rowId> --to <boardId> [--dry-run] [--create-options] [--expect <updatedAt>]`. MCP: `task_move`(같은 `expectedUpdatedAt` 필드로 낙관적 잠금). (`task mv` 는 같은 보드 안 순서 변경이다 — 이름이 비슷하니 헷갈리지 말 것.)
    - **대상 보드 오류는 일부러 구분 안 된다(D3)**: `targetDatabaseId` 가 존재하지 않든, 다른 워크스페이스든, 삭제됐든, 보드(database)가 아니든, 볼 수 없는(접근 게이트 거부) 보드든 — 전부 `lib/pageGuard.ts` 의 `notFound()` 와 **똑같은 404** (`{ error: "페이지를 찾을 수 없습니다." }`)로 응답한다. "존재는 하지만 권한이 없다" 를 알려주면 그 자체로 정보가 새기 때문이다. 원인은 서버 debug 로그에만 남는다 — 클라이언트 메시지로 원인을 유추하려 하지 말 것.
   - **매핑 규칙**(순수 로직 `lib/rowMove.ts`): 속성 id·옵션 id 는 보드마다 다르므로 **이름+타입** 으로 짝을 찾는다. text/number/date/checkbox/person = 값 복사 · select = **옵션 이름** → 대상 옵션 id(없으면 버림, `createMissingOptions:true` 면 대상 속성에 옵션을 만들고 색 유지) · multiselect = 값마다 같은 규칙 · relation = 두 속성의 `targetDatabaseId` 가 **같을 때만** 복사하고 대상 보드에 실재하는 id 만 남긴다(자기 보드를 가리키는 `선행 태스크` 는 보드가 바뀌면 반드시 끊긴다) · 짝이 없거나 타입이 다르면 버림. 빈 값은 보고하지 않는다. **제목**(첫 text)은 같은 이름이 없으면 대상의 첫 text 속성으로 옮기고, 그것도 없으면 **400 + dropped**.
   - **거부**: 같은 보드 400 · 대상이 보드가 아님/삭제/다른 워크스페이스 404 · **하위 항목이 있으면 409 `{childCount}`**(자식을 먼저 옮기거나 분리) · `expectedUpdatedAt` 불일치 409 + 현재 행 · 계획을 세운 뒤 행이 바뀌면(CAS: updatedAt·보드·자식 없음) 409 — 옵션 생성까지 트랜잭션으로 롤백.
   - **보고만 하는 것**: `referencedBy` = 이 행을 relation 으로 가리키는 다른 행 수. 이동을 막지 않지만 그 연결은 원본 보드를 가리키는 relation 에 다른 보드 행 id 가 남는 셈이라 `(삭제된 행)` 으로 보인다.
   - **dryRun 을 먼저** 돌려 `dropped` 를 확인하고 옮긴다 — 버려진 값은 되돌릴 방법이 없다. dryRun 은 아무것도 쓰지 않고 같은 보고를 200 으로 준다.
   - 상태·담당자 **알림을 보내지 않는다**(재배치지 변경이 아니다). 활동 로그에 `moved`(보드 이동)로 남는다.
6. 보드 새로 생성: `POST /api/databases` `{ "title"?, "parentId"?, "projectId"? }`(projectId=프로젝트에 연결) → 위 4속성(상태: 할 일/진행 중/완료, 우선순위: 낮음/보통/높음)·뷰(표/보드)가 갖춰진 보드. 단순 목록: `GET /api/tasks[?board=&assignee=&status=open|all&limit=1..200]` → `{ total, shown, tasks:[{id,title,due,status,statusColor,assignee,board}], databaseId }`. `total` 은 status·assignee 필터를 거친 뒤·limit 를 자르기 전의 건수(기본 status=open 이면 완료·취소는 세지 않는다), `shown` 은 이번 응답에 담긴 수. 기본은 **열린 태스크 50건**(완료·취소 제외) — 전체는 `status=all`, 더 보려면 limit(최대 200). `limit=all`(상한 없음)은 CLI `task mine --all` 이 호출자 본인의 열린 태스크를 전부 가져올 때 쓰며, `task ls` 는 계속 200 으로 제한된다. CLI: `task ls [--all] [--limit n]`(마지막 줄 `총 N건 중 M건`), MCP `task_list` 도 `status`·`limit`.

**리뷰 → 보드 (팀 규칙 4 자동화)**: 리뷰·감사 문서의 발견 표(`## N.` 아래, 첫 열이 `B1`·`U3`·`A-5` 같은 코드)는 채팅에 나열하지 말고 `pnpm ws review import <docId> [--prefix "[리뷰 10/08]"] [--board <id>] [--dry-run]` 로 보드에 올린다. 접두어 기본값은 문서 제목의 `(YYYY-MM-DD)`. 제목은 `<접두어> <코드> <발견 첫 문장>`(90자), 심각도 높음/중간/낮음 → 우선순위(중간은 보드의 '보통'으로도 매칭), 발견·근거·제안·출처(`/p/<docId> §섹션`)는 태스크 **댓글**로 붙는다(태스크마다 설명 문서를 만들지 않으려는 것 — 목록·검색 소음). 보드 행 제목에 `<접두어> <코드>` 가 이미 있으면 건너뛰어 재실행해도 중복이 없다(검색 API 는 보드 행을 색인하지 않아 보드 행 제목으로 판정한다). 먼저 `--dry-run` 으로 목록을 확인 — 첫 줄에 `대상 보드: <제목> · <id>` 가 나온다(`--board` 없으면 첫 database 페이지). 행마다 실패를 격리해 한 행의 생성·댓글 실패는 `⚠` 한 줄로 알리고 계속하며(댓글만 실패한 행은 재실행 때 건너뛰므로 본문을 손으로 채울 것), 끝에 `생성 N · 건너뜀 M · 실패 K`. 매핑 밖 심각도는 옵션 이름 정확 일치로만 찾고 없으면 `⚠ 우선순위 미매칭`. 제목의 강조 토큰(`**`·`_x_`·`~~`·`==` 등)만 벗기고 snake_case 밑줄은 남긴다. 순수 로직 `lib/reviewImport.ts`.

7. **체크리스트**(행별): `GET/POST /api/rows/<rowId>/checklist` `{ text }` · `PATCH/DELETE /api/rows/<rowId>/checklist/<itemId>` `{ done?, text? }`.
8. **댓글**(행별): `GET/POST /api/rows/<rowId>/comments` `{ body }`(작성자=현재 사용자). 태스크 상세 드로어의 체크리스트/댓글 탭이 이걸 사용.

> **relation 속성(격차 C2)**: `POST /api/databases/<id>/properties {name, type:"relation", config:{targetDatabaseId}}` — **대상 보드 필수**(같은 보드를 가리켜도 된다: '선행 태스크'). 값은 대상 보드의 **행 id 배열**이고, 행 생성·수정 시 대상 보드에 실재하는 id 인지 검증해 아니면 **400 + unknownRowIds**(조용히 버리지 않는다). 화면에서는 제목 칩으로 보이고, 제목을 못 찾으면 `(삭제된 행)` 으로 남긴다. CLI: `board prop add <boardId> <name> --type relation --target <보드id>`. (C2 이전엔 타입 선언만 있고 생성이 차단돼 있어 **`pnpm ws task block` 이 400 으로 죽어 있었다** — 지금은 동작한다.) multiselect 는 여전히 생성 차단(미구현).
>
> **속성/옵션 API**(W5): `POST /api/databases/<id>/properties {name,type,config?}` · `PATCH .../properties/<propId> {name?, addOption:{name,color?}, renameOption:{id,name}}` · `DELETE`. CLI: `board prop add|opt|rm`. **뷰 API**(2026-08-08 신설): `GET/POST /api/databases/<id>/views` `{name, type(table|kanban|gallery|list|calendar|timeline — 뒤 4종은 격차 C1 에서 추가), config?}` · `PATCH/DELETE .../views/<viewId>`. `config` 는 `{sort:{propId,dir}|null, filter:{conj:'and'|'or',rules:[{propId,op,value}]}|null, groupBy, meta[]}` 이고(`op` = eq/ne/contains/notContains/empty/notEmpty/gt/lt/checked/unchecked — 속성 타입별 허용 목록은 `lib/dbFilter.OPS_BY_KIND`)(`meta` = 행 메타 가상 열: `createdAt`·`updatedAt`·`createdBy`·`updatedBy`)(`dateProp`·`endProp` = 달력·타임라인 기준 날짜 속성, 미지정이면 첫 date 속성) **넘긴 키만 병합**된다(정렬만 바꿔도 groupBy 가 살아남는다). 마지막 뷰는 삭제 불가(400). CLI: `view ls|add|set|rm` — `view set <boardId> <viewId> --sort <propId:asc|desc|none>`. · 칸반: `/p/<boardId>?view=kanban`, 테이블: `?view=table`.
>
> **집계·서브아이템·의존성(격차 C6)**: ① **열 집계** — 표 아래 줄에서 열마다 함수를 고르면 뷰 `config.agg`(`{propId: fn}`)에 저장되고 칸반 컬럼 머리에도 첫 집계가 표시된다. 함수는 타입별로 다르다(숫자=합계/평균/최소/최대, 체크박스=체크수/비율, 날짜=가장 이른/늦은, 공통=행수/채워짐/비어있음/고유값). 순수 로직 `lib/aggregate.ts` — **평균은 값이 있는 것만 나누고**(빈칸을 0으로 세면 조용히 낮아진다), **값이 없으면 0 이 아니라 `—`**('합이 0'과 구분). `agg` 는 서버가 **열 단위로 병합**한다(통째로 갈아끼우면 두 열을 연달아 바꿀 때 응답 순서가 뒤바뀌며 한쪽이 사라진다 — 실제로 재현됨). ② **서브아이템** — `PATCH /api/rows/<id> {parentRowId}`. 같은 보드여야 하고 **자기 자신·자기 하위는 400**(순환 금지). 표에서 들여쓰기+접기로 보이고, 정렬을 켜면 계층 대신 평평하게 나온다. 순수 로직 `lib/subitems.ts`(부모가 목록에서 빠지면 자식을 **최상위로 올린다** — 필터 때문에 행이 사라지면 안 된다). ③ **의존성** — `선행 태스크` relation(→C2)의 선행 행이 아직 완료가 아니면 행 앞에 `⛔n`. 완료 판정은 상태 옵션 **이름**으로 한다(옵션 id 는 보드마다 다르다).
>
> **뷰 6종(격차 C1)**: `table`(인라인 편집) · `kanban`(드래그 이동) · `gallery`(카드 그리드) · `list`(한 줄 요약) · `calendar`(월 격자 — 날짜 속성 기준) · `timeline`(기간 막대 — 시작/종료 날짜). 뒤 4종은 **읽기 중심**이고 편집은 행을 열어서 한다. 달력·타임라인은 날짜 속성이 없으면 그 사실을 화면에 알리고, **날짜가 없어 못 놓은 행 수를 항상 표시**한다(조용히 빠지면 '행이 사라졌다'로 읽힌다). 배치 계산은 순수 함수 `lib/viewLayout.ts`(월 격자·날짜 버킷·막대 좌표) — **시간대 변환을 하지 않는다**(문자열 날짜를 그대로 비교). CLI: `view add <boardId> <이름> --type calendar`, `view set … --date <propId> --end <propId>`.
>
> **표 뷰 열린 것만·가상 스크롤(화면 전용, API 무관)**: ① **열린 것만** — 상태(select, 이름 status|상태) 속성이 있는 보드의 표 뷰에서 완료·취소 행을 숨긴다(브라우저 localStorage `ws-db-open-only:<boardId>`, 기본 ON). 뷰 정렬이 없으면 **최상위 행만** 수정 시각 내림차순이고 서브아이템은 부모 아래 트리를 유지한다. 이 화면에서 방금 편집한 행은 완료로 바꿔도 흐리게 남고, 뷰·토글·검색·필터를 바꾸면 숨겨진다. `초기화 (n/m)` 의 n 은 표에 실제로 보이는 행 수다. ② **가상 스크롤** — 표가 150행을 넘으면 보이는 창 + 여유분만 DOM 에 그린다. 그래서 **창 밖 행은 브라우저 찾기(Ctrl/Cmd+F)·Tab 이 못 닿는다**(검색창은 전체 행을 걸러서 괜찮다). 전부 그리려면 URL 에 `?virtual=0` 을 붙이거나 콘솔에서 `localStorage.setItem("ws-table-virtual","0")` 후 새로고침(되돌리기 `removeItem`). 플래그는 표가 마운트될 때 한 번 읽는다.

## 문서 (file-first)

CLI: `pnpm ws doc new|save|cat|rm|rename|mv|type|backlinks|archive|unarchive` (`doc new <title> --folder "<이름>" --type <docType> [--template design|plan|report|handoff] [--unique]`, `doc templates`, `doc type <id> <type|none>`), 즐겨찾기 `fav ls|add|rm|order`. raw API:

**새 문서는 `--folder` 로 폴더를 지정한다. 태스크 설명은 `--type task_note`. 프로젝트 뿌리에 바로 두면 위키 점검에 경고가 뜬다.**


- **문서 템플릿**: `POST /api/pages` 본문 `template: "design"|"plan"|"report"|"handoff"`(그 외 400) 이면 초기 본문이 한국어 뼈대(`> 템플릿: <name> · <날짜>` 줄 포함)이고 `docType` 기본값도 템플릿 것(본문 `docType` 이 우선). CLI `doc new <title> --template design`, 목록은 `doc templates`. 에이전트는 설계/계획/리포트/핸드오프 문서를 템플릿으로 시작한다. database 종류에는 무시된다.
- **보관(archive)**: `POST /api/pages/archive {id, archived:boolean}` → editor+, 볼 수 없거나 없는/삭제된 페이지는 404. 성공 `{page:{id,archived,archivedAt}, changed}`(이미 그 상태면 `changed:false`, 쓰기·활동 없음). 휴지통과 다르게 삭제가 아니다: 사이드바·`GET /api/pages`·검색·문서 목록에서 **기본 제외**, `updatedAt` 은 그대로. 보관함 조회 `GET /api/pages?archived=1`(보관만)·`?archived=all`(둘 다 — 보관 행에 `archived:true`)·`GET /api/search?q=…&archived=1`(보관 포함). database 종류도 보관 가능(행 그대로). 보관은 조상 기반이다 — 보관한 문서의 하위 문서도 함께 숨겨지고(자식 행에는 쓰지 않음, 부모를 해제하면 함께 돌아옴), 보관함(`?archived=1`)에는 보관한 문서(루트)만 보인다. `?archived=all` 은 하위 문서에도 `archived:true` 를 붙인다. 검색도 같은 규칙. CLI `doc archive <id>`·`doc unarchive <id>`·`doc ls --archived`. UI: 문서 리더 헤더 `보관`/`보관 해제`, 목록 `보관 포함`·`보관함`, 행 `보관됨` 배지. 그래프(`/api/graph`)는 보관 문서(조상 규칙)를 노드에서 뺀다(프로젝트는 유지). 검색은 보관 id 가 2,000개를 넘으면 `notIn` 대신 후보를 읽은 뒤 거른다. 프로젝트 선택 목록(lessons inspect/injections, clip, import 이름 매칭)은 보관 프로젝트 제외. `GET /api/context` 는 4A 에서 이미 보관을 거른다.
- **같은 제목 경고**: `POST /api/pages`(doc) 는 같은 프로젝트에 같은 제목(공백·대소문자 무시, `Untitled`/`제목 없음` 제외) 문서가 있으면 성공 응답에 `warnings:[{code:"duplicate_title",pages:[{id,title}]}]` 를 붙인다. 본문 `ifUnique:true` 면 만들지 않고 **409** `{error,duplicates}`. CLI `doc new --unique`(중복 경고는 stderr). 문서 목록 UI 는 중복 행에 `제목 중복` 배지. 이 검사는 권고용이다(원자적이지 않아 동시 생성 두 건은 둘 다 통과할 수 있음). 볼 권한이 없는 문서는 중복으로 보고하지 않는다. `--unique` 409 시 CLI 는 `중복: <id> <title>` 을 stderr 에 출력.
- 목록: `GET /api/pages`(doc=`kind:"doc"`; 페이지마다 `docType`(design|plan|brief|report|handoff|task_note|other|null)·`childCount`·`isFavorite` 포함). 본문: `GET /api/pages/<id>` → `{ page(rev 포함), markdown }`.
- **태스크 설명 기본 제외**: `[태스크 설명]` 문서(`docType=task_note`, 이관 전엔 제목 접두어로 판정)는 문서 목록 UI·`GET /api/search`·`GET /api/context`(세션 주입)에서 기본 제외 — 포함하려면 `?includeTaskNotes=1`(문서 목록 UI는 "태스크 설명 포함" 체크). 태스크 드로어(`contentPageId`)에서는 그대로 열린다. MCP `doc_list` 도 같은 기본값이며 입력 `{ projectId?, folder?(부모 제목), docType?, includeTaskNotes?, archived?("only"|"all" — 기본은 보관 제외, `GET /api/pages?archived=` 와 동일), limit?(기본 30) }`, 출력 `{ total, shown, docs[] }`(`updatedAt` 내림차순).
- 생성: `POST /api/pages` `{ "title", "kind":"doc", "projectId"?, "parentId"?, "docType"?, "folder"? }`(`folder`=같은 프로젝트 최상위의 같은 제목 폴더 문서를 부모로 쓰고 없으면 먼저 만든다; `parentId` 가 있으면 무시). `--folder` 의 같은 제목 검사는 폴더 안이 아니라 프로젝트 전체(프로젝트 없음 포함) 기준이다. **폴더 = 자식을 가진 doc 페이지**(별도 타입 없음) — `parentId`로 중첩하면 사이드바에서 📁로 표시.
- 본문 저장: `PUT /api/pages/<id>` `{ "markdown", "title"?, "baseRev"? }` → doc은 `docs/<프로젝트>/<제목>.md`로 기록(file-first). **markdown 없이 호출하면 제목만 갱신(본문 보존)**. `baseRev`(opt-in, GET의 `page.rev`)가 서버와 다르면 **409 + 현재 상태 반환** — 에이전트는 재조회 후 병합 저장. 저장마다 rev+1 되고 버전이 적재된다.
- **버전 히스토리**: `GET /api/pages/<id>/revisions`(목록, `?rev=<n>`=본문 포함 단건) · `POST /api/pages/<id>/revisions {rev}`(복원 — 새 리비전으로 적재). CLI: `doc history <id> [--rev n]`, `doc restore <id> --rev n`. UI: 문서 리더 "히스토리" 패널.
- 메타 변경: `PATCH /api/pages/<id>` `{ projectId?, title?, icon?, parentId?, docType?(null=해제) }` — 주어진 필드만 갱신. `projectId`(null=미분류) · `title`(이름변경) · `parentId`(폴더 이동, 자기 자신/자손으로의 이동은 400 거부). CLI: `doc rename <id> <title>`, `doc mv <id> [--parent <id>] [--project <id>]`.
- 삭제: `DELETE /api/pages/<id>` — **휴지통으로 소프트 삭제**(md 파일 보존). 자식 있으면 409, `?recursive=1`=서브트리 일괄. **휴지통**: `GET /api/trash` · `POST /api/trash/<id>`(복원) · `DELETE /api/trash/<id>`(영구 삭제 — 이때만 파일 제거). CLI: `doc rm <id> [--recursive]`, `trash ls|restore|purge`. UI: 설정 › 휴지통.
- **위키링크**: 본문 `[[문서 제목]]` 자동 링크. 백링크: `GET /api/pages/<id>/backlinks`.
- 보드 화면 헤더의 프로젝트 셀렉트, 사이드바의 폴더/문서 드래그·이름변경·삭제가 모두 위 PATCH/DELETE 사용.
- ⚠️ 정리/삭제는 가능하면 soft-delete(`Page.deletedAt`), `.md` 파일 보존.

### 즐겨찾기·최근 (사이드바 ⭐ 🕘, 사람별)

| 하는 일 | API | CLI |
|---|---|---|
| 즐겨찾기 목록 | `GET /api/favorites` → `{ favorites:[{pageId,title,kind,docType,projectId}] }` | `fav ls` |
| 추가 / 해제 / 순서 | `POST /api/favorites {pageId}` · `DELETE ?pageId=` · `PATCH {order:[pageId]}` | `fav add\|rm <pageId>` · `fav order <id>…` |
| 최근 열람 | `GET /api/visits?limit=8` → `{ visits:[{…, visitedAt}] }` · `POST {pageId}`(문서·보드 화면이 마운트 때 1회) | `visit ls [--limit n]` |

목록은 D3 필터(볼 수 없는 페이지 제외), 추가·기록은 볼 수 없으면 404 게이트. 최근은 사람당 20개만 보관(초과는 오래된 것부터 삭제).

## 공유 범위 — 페이지·프로젝트 권한 (격차 D3)

워크스페이스 3역할 위에 **페이지·프로젝트 단위 접근**이 얹혀 있다. 판정 로직은 순수 함수 `lib/pageAccess.ts`, 라우트가 쓰는 게이트는 `lib/pageGuard.ts`.

- **모델**: 페이지는 기본 `inherit`(위를 따름). `restricted` 로 잠그면 그 페이지와 **자손 전체**가 잠긴다. 프로젝트를 잠그면 그 프로젝트의 페이지 전체가 잠긴다.
- **더 구체적인 쪽이 이긴다**: 자손의 부여 > 조상의 잠금 · 페이지 > 프로젝트 · 사용자 부여 > 팀 부여.
- **워크스페이스 역할이 천장**이다. viewer 에게 `edit` 를 부여해도 보기까지 — 부여가 역할 승격 경로가 되면 RBAC 이 뚫린다.
- **확정 정책 2가지**(2026-08-09): ① **admin 은 우회한다**(잠금 방지 — 이 앱에 '관리자도 못 보는 비밀'은 둘 수 없고, 공유 패널이 그 사실을 표시한다). ② **편집할 수 있으면 공유 범위도 정한다**.
- **404 vs 403**: 볼 수 없으면 **404**(존재 자체를 숨긴다). 볼 수는 있는데 못 고치면 403.
- **자기 잠금 방지**: 페이지·프로젝트를 `restricted` 로 바꾸면 **잠근 사람에게 edit 부여가 자동으로 남는다**(작성자·admin 제외). 이게 없으면 editor 가 자기가 건 잠금을 자기가 못 푼다 — 실제로 팀 메인 보드로 겪었고 admin 이 풀어 줘야 했다.
- **화면 표시**: `GET /api/pages` 가 페이지마다 `restricted`(조상·프로젝트 상속 포함)와 `restrictedSelf`(잠금이 이 페이지에서 시작됨)를 함께 준다(`lib/pageAccess.effectiveRestricted`). 사이드바 트리는 **시작점에만** 자물쇠를 그리고(자손마다 붙이면 트리가 자물쇠로 뒤덮여 안 읽힌다), 평평한 문서 목록은 **상속된 것도** 표시한다(계층으로 유추할 수 없으므로).
- **알림도 권한을 본다**: 비공개(자기·조상·프로젝트 중 하나라도 restricted) 페이지·보드는 슬랙 채널 알림(`task_*`·`doc_saved`·`comment_added`)을 **발화하지 않는다** — 태스크 제목·코멘트 본문은 그 자체가 내용이라 채널 한 줄로 잠금이 무너진다. 판정은 `isRestrictedPage()`(뷰어 없는 자리용: "볼 수 있나"가 아니라 "아무나 봐도 되나").
- **막히는 곳**: 단건(문서·보드·행·코멘트·체크리스트·히스토리·백링크·휴지통)뿐 아니라 **목록·집계 전부** — `/api/pages`·검색·개념검색·물어보기·그래프·점검·태스크·내보내기·**`/api/context`(세션 자동 주입)**·`/p/[id]` 서버 렌더까지. `scripts/page-access-coverage.test.ts` 가 Page/DbRow 를 만지는 라우트에 게이트가 있는지 **정적으로 강제**한다(면제는 사유와 함께 등록).

API·CLI:

| 하는 일 | API | CLI |
|---|---|---|
| 범위·부여 조회 | `GET /api/pages/<id>/grants` | `pnpm ws page shares <pageId>` |
| 잠금 전환 | `PATCH .../grants {visibility}` | `pnpm ws page restrict <pageId> <on\|off>` |
| 부여 | `POST .../grants {userId\|teamId, level}` | `pnpm ws page share <pageId> --user <id>\|--team <id> [--level view\|edit]` |
| 회수 | `DELETE .../grants?grantId=` | `pnpm ws page unshare <pageId> <grantId>` |

프로젝트도 같은 모양(`/api/projects/<id>/grants`, `pnpm ws project shares|restrict|share|unshare`). 사람에게 부여하면 인앱 알림이 가고, 모든 변경은 활동 로그에 남는다. UI 는 문서·보드 하단 "공유" 패널(잠겨 있으면 열지 않아도 `· 비공개` 배지).

## HTML 퍼블리시 — 초대 게스트 전용 (2026-09)

HTML 파일·폴더·zip 을 올리면 `/s/<slug>` 링크가 생기고, **초대한 이메일로 Google 로그인한 사람만** 본다. 게스트는 워크스페이스 멤버가 아니다. 설계·결정은 TeamSpace 의 'HTML 퍼블리시' 문서·결정 참고.

| 하는 일 | API | CLI |
|---|---|---|
| 목록 | `GET /api/sites` | `site ls` |
| 생성 | `POST /api/sites` multipart `file`(.html/.zip), `title?`, `projectId?`, `invites?`(쉼표) | `site publish <file\|dir\|zip> [--title] [--project] [--invite a,b]` |
| 새 버전 | `POST /api/sites/<id>/versions` multipart `file` | `site publish <path> --site <id>` |
| 상세 | `GET /api/sites/<id>` → `{site,url,versions,invites}` | `site show <id>` |
| 수정·롤백·비활성 | `PATCH /api/sites/<id> {title?,status?,currentVersion?,projectId?,apiUpstream?}` | `site rollback <id> <v>` · `site disable\|enable <id>` |
| API 프록시 연결·해제 | `PATCH /api/sites/<id> {apiUpstream:"http://127.0.0.1:<port>"\|null}` (목록·상세 응답에 `apiUpstream`) | `site api <id> http://127.0.0.1:<port>` · `site api <id> --off` |
| 삭제(소프트) | `DELETE /api/sites/<id>` | `site rm <id>` |
| 초대·회수 | `POST\|DELETE /api/sites/<id>/invites {emails:[]}` | `site invite\|uninvite <id> <email...>` |
| 접근 이력 | `GET /api/sites/<id>/access` → `{accounts:[{email,kind(invited\|member\|revoked),count,firstAt,lastAt,recent[]}],total,windowDays}` | `site access <id>` |
| 인테이크 목록 | `GET /api/sites/<id>/intake` → `{entries:[{id,service,fieldCount,submittedBy,submittedByMember,createdAt,revealCount,lastRevealedAt}],keyMissing}` (값·암호문 없음) | `site intake <id>` |
| 인테이크 열람 | `GET /api/sites/<id>/intake/<entryId>` → `{entry:{…,fields:[{label,value}]}}` — 복호화(**admin**), **열람이 활동 로그에 남는다** | `site intake show <id> <entryId> [--reveal]` |
| 인테이크 삭제 | `DELETE /api/sites/<id>/intake/<entryId>` (**admin**) | `site intake rm <id> <entryId>` |
| (게스트 제출) | `POST /api/site-intake {items:[{service,fields:[{label,value}]}]}` — 퍼블리시 페이지에서 상대경로 `fetch('api/site-intake')` 로만 | CLI 없음(게스트 전용) |

MCP: `site_publish {path,title?,siteId?,invites?}` · `site_list`. UI: 사이드바 › 퍼블리시(`/sites`).

- **왜 샌드박스인가**: 올린 HTML 의 JS 가 앱과 같은 출처에서 돌면 로그인한 팀원 브라우저로 `/api` 를 부를 수 있다. Funnel 은 호스트가 하나라 서브도메인 분리가 불가능하고, 쿠키는 포트를 구분하지 않아 포트 분리도 소용없다. 그래서 셸(`/s/<slug>`)이 세션을 판정한 뒤 `/pub/<HMAC토큰>/…` 을 `sandbox` iframe 으로 띄운다. `/pub` 응답에는 항상 `CSP: sandbox …`(**allow-same-origin·allow-top-navigation 없음**)·`no-referrer`·`nosniff` 를 붙인다. sandbox 문자열의 원천은 `lib/sites/headers.SITE_SANDBOX` 하나다.
- **다운로드 버튼**: 샌드박스는 opaque origin 이라 `<a href="x.pdf" download>` 의 `download` 속성이 교차 출처로 무시되고(그냥 iframe 이동), PDF 는 샌드박스 안에서 열리지도 않는다. 페이지에서는 **`<a href="x.pdf?download">`** 처럼 `?download` 를 붙인다 — `/pub` 가 `Content-Disposition: attachment`(UTF-8 파일명)를 붙여 `allow-downloads` 로 실제 저장된다.
- **API 프록시**(`app/pub/[token]/[...path]/route.ts`, 규칙 `lib/sites/apiProxy.ts`): 페이지가 **상대경로** `fetch('api/x')` 를 부르면 `/pub/<token>/api/x` 가 되고, 사이트에 `apiUpstream` 이 있으면 토큰 검증(403) → `siteAccessById` 재판정(404/403) → 경로 검증(`..`·빈 세그먼트·백슬래시·인코딩 슬래시 404) 후 `<upstream>/api/x?<원 쿼리>` 로 넘긴다. 메서드 GET·POST·PUT·PATCH·DELETE(+OPTIONS 프리플라이트). `apiUpstream` 이 없으면 GET 은 기존 파일 서빙, 나머지는 404.
  - **upstream 은 루프백만**: `http(s)://127.0.0.1|localhost|[::1]:<port>` (포트 필수, 경로·쿼리·userinfo 불가, 끝 슬래시 제거해 저장) — 그 외 400. SSRF 방지. 설정 권한은 editor(프록시는 인증 헤더를 넘기지 않아 앱 자신을 가리켜도 401 — 단 그 루프백 포트의 무인증 서비스는 초대 게스트에게 열리니 무엇을 연결하는지가 보안 경계), 연결·해제는 활동 로그에 남는다(주소 제외).
  - **넘기는 헤더**: 원 요청의 `content-type`·`accept` 만 + `x-teamspace-site-id`·`x-teamspace-viewer`(판정된 이메일, 소문자)·`x-teamspace-member`(true/false). 쿠키·authorization·host 는 절대 안 넘긴다. **응답**은 status·body·content-type 만 살리고 `cache-control: no-store`·`nosniff`·`no-referrer`·CSP sandbox·`access-control-allow-origin: *` 를 붙인다(set-cookie 등 버림).
  - **왜 CORS 가 필요한가**: sandbox iframe 은 opaque origin(Origin: null)이라 같은 호스트 fetch 도 교차 출처다. 인증이 쿠키가 아닌 경로 토큰이라 `*`(credentials 없음)로 연다. 403/404 응답에도 CORS 를 붙여 페이지가 만료(403)를 읽을 수 있게 했다.
  - **상한**: 요청 본문 1MB(413), 응답 5MB(502), 타임아웃 `SITE_API_TIMEOUT_MS`(기본 600000ms, 504), 연결 실패 502 `{error:"upstream 에 연결할 수 없습니다"}`(내부 주소 비노출). undici 300초 기본 타임아웃을 피하려고 `node:http` 로 호출한다. 보는 사람이 연결을 끊으면 upstream 요청도 끊는다.
  - 접근 이력(SiteAccess)은 기록하지 않는다(셸 열람만).
- **토큰**: `AUTH_SECRET` 에서 HKDF 로 파생한 키로 서명한다. TTL 1시간이고 버전이 고정된다. `/pub` 는 **매 요청 초대를 다시 판정**하므로 회수·비활성화가 즉시 반영된다. 1시간 넘게 머물면 지연 로딩 에셋이 실패하며, 셸을 새로고침하면 복구된다.
- **로그인**: `isSignInAllowed` 경로 (c) = 살아 있는 사이트의 `SiteInvite` 에 있는 이메일. 게스트는 멤버 행이 없으므로 `requireCtx` 가 워크스페이스를 막는다. **자동 가입은 허용 도메인 이메일만**(`canAutoJoinDefaultWorkspace`) — 이 제한이 없으면 게스트가 `/dashboard` 를 여는 순간 editor 가 된다.
- **번들 규칙**(`lib/sites/bundle.ts`): 20MB·해제 50MB·파일 500개. 최상위 폴더 하나는 벗긴다. `index.html` 필수. 확장자는 허용 목록만 받고, 숨김·`__MACOSX` 는 건너뛴다. **루트 기준 경로(`/assets/x.js`)는 로드되지 않는다** — 경고가 뜨면 상대경로로 빌드한다(`vite build --base=./`). CLI·MCP 가 폴더를 묶을 때 숨김 파일·`node_modules` 는 뺀다.
- **저장**: `DATA_DIR/sites/<siteId>/v<n>/`(원자적 rename). 최근 10개 버전만 유지하고 current 는 지우지 않는다. 백업은 `sites.tar`.
- **미들웨어**: `api/sites` 는 matcher 밖(10MB 넘는 multipart, `/api/import` 와 같은 사유)이고 `/pub/`·`/api/site-intake` 는 조기 통과한다. 셋 다 라우트가 스스로 막는다.

### 인테이크 — 게스트가 폼으로 보낸 계정 정보 (2026-09)

외주사·거래처에게 계정 정보를 받아야 할 때, 퍼블리시 페이지에 폼을 올리고 그 제출을 암호화해 받는다. 페이지 원본은 `site-sources/account-intake/index.html` — 줄(서비스)은 그 파일의 `ROWS` 배열 하나로 정의되고, `kind: "handover"`(지금 우리 계정에 있어 넘겨야 하는 것) 와 `kind: "create"`(아직 없어 상대가 처음부터 자기 계정으로 만들 것) 를 색·배지·묶음 제목·상태 선택지로 갈라서 보여준다. `omit`(그 줄에서 뺄 입력칸 key)·`caution`(적으면 안 되는 것)도 줄 단위 속성이다 — 구글 계정·결제수단 줄은 비밀번호·2FA 칸 자체가 없다.

- **누가 쓰나**: 초대 게스트만. 페이지가 상대경로 `fetch('api/site-intake')` 를 부르면 `/pub/<token>/api/site-intake` → (사이트의 `apiUpstream`) → `POST /api/site-intake`. 그래서 **사이트에 `apiUpstream` 을 TeamSpace 자신으로 걸어야 한다**: `pnpm ws site api <siteId> http://127.0.0.1:3002`.
- **누가 읽나**: 워크스페이스 멤버만. 목록은 viewer, **열람·삭제는 admin**(이 레포에서 editor 는 허용 도메인 사용자가 로그인만 하면 자동으로 받는 기본 역할이라 남의 계정 비밀번호를 걸 수 없다). 게스트에게는 읽기 경로가 아예 없다(POST 만 export).
- **자체 인증 두 겹**(`app/api/site-intake/route.ts`): ① `x-teamspace-proxy-sig` — 프록시가 `AUTH_SECRET` 파생 키로 **1분짜리** MAC 을 붙인다(`lib/sites/proxyIdentity`). 서명은 신원뿐 아니라 **메서드·경로·본문 해시**에 묶여 있어서, 새어 나가도 다른 내용을 그 게스트 이름으로 심을 수 없다. ② `siteAccessById` 재판정 — 사이트가 살아 있고 그 이메일이 **지금도** 초대돼 있어야 한다. 그래서 middleware `isOpenApi`(정확 일치)·authz-coverage WHITELIST 에 올라가 있다.
- **인터록 2종**(리뷰 C1 — `apiUpstream` 을 앱 자신으로 걸면 게스트 요청이 우리 `/api/*` 로 들어온다):
  ① `requireCtx` 는 **프록시 헤더가 붙은 요청을 전부 거절한다**(`lib/workspace.cameFromSiteProxy`). 프록시는 그 헤더를 항상 붙이고 게스트는 지울 수 없으므로 우회가 없다. 이 한 줄이 `/api/sites/**` 뿐 아니라 requireCtx 를 쓰는 모든 라우트를 닫는다.
  ② 인테이크 라우트는 `AUTH_OPEN_API=true` 로 세션 없이 얻은 부트스트랩 admin 을 거절한다(`lib/bootstrapCtx.isBootstrapCtx`). 로그인 세션·에이전트 토큰은 그대로 동작하므로 로컬 개발은 막히지 않는다.
- **암호화**: 값은 `SITE_INTAKE_KEY` 에서 HKDF 로 판 키로 AES-256-GCM(`lib/sites/intakeCrypto`). 키는 **base64/hex 로 32바이트 이상만** 받는다(`openssl rand -base64 32`) — HKDF 는 스트레칭을 안 하므로 사람이 고른 문구는 거부한다. 암호문은 **AAD 로 그 행(사이트·제출자·항목명)에 묶여** 있어 다른 행으로 옮겨 붙이면 풀리지 않는다. 평문으로 남는 것은 `service`(항목 이름표)뿐. **키가 없거나 약하면 제출을 503 으로 거절한다**(평문 저장 금지) — `AUTH_SECRET` 과 일부러 분리했다.
- **상한**: 항목 40개·칸 24개·값 4000자·본문 256KB. 넘치면 **잘라 저장하지 않고 400 으로 거절한다**(조용한 손상 금지). 값의 앞뒤 공백은 보존한다(공백 든 비밀번호). 같은 (사이트·이메일) 10분 12회(429) — 형식 오류는 한도를 깎지 않는다. 값은 로그·에러 메시지에 절대 싣지 않고, 복호화 응답에는 `cache-control: no-store` 를 붙인다.
- **UI**: 사이트 상세(`/sites/<id>`) 의 "받은 계정 정보" — `apiUpstream` 이 걸려 있거나 받은 값이 있으면 나타난다. 값 보기(admin)·복사·삭제. CLI 는 기본이 가림이고 `--reveal` 이어야 평문을 찍는다(스크롤백에 남는다).
- **페이지 쪽 주의**: `/pub` 토큰은 1시간이고 갱신되지 않는다. 페이지가 5분마다 살아 있는지 찔러 보고, 끊기면 "복사 → 새로고침 → 붙여넣기" 를 안내한다(`내용 꺼내기`/`이전 내용 붙여넣기`). 샌드박스라 브라우저 저장소를 못 쓰기 때문이다. 꺼내기 형식은 `## 서비스` + `라벨: 값` 이고, **한 줄로 안전하지 않은 값(개행·역슬래시·앞뒤 공백·따옴표 시작·가림표시 모양)은 JSON 문자열로 감싼다** — 감싸지 않으면 2FA 백업코드가 첫 줄만 남는다. 꺼낼 때 스스로 왕복 검사를 하고, 되돌리지 못한 줄은 **개수로 보고한다**(조용히 버리지 않는다). 만료 경로에서는 비밀번호까지 포함해 꺼낸다(그래야 안내대로 복원된다 — 복사본은 쓰고 지우라고 안내한다).
- **접근 이력**(`SiteAccess`): 셸(`/s/<slug>`) 열람만 기록하고 `/pub` 에셋은 기록하지 않는다. 같은 계정 10분 내 재열람은 생략, IP·UA 는 저장하지 않는다. kind 는 **현재** 기준(지금 초대돼 있으면 invited, 멤버로 본 기록이면 member, 아니면 revoked). 조회는 최근 180일·5000건. 상세 화면 초대 섹션 아래.
- **초대 알림은 자동 발송하지 않는다**(메일 인프라 없음). 응답·화면의 복사 문구를 사람이 전달한다.

## 내보내기 / 가져오기 (격차 E1·E2 — 데이터 반출입)

> **UI: 설정 › 데이터 반출입**(`components/ws/DataTransfer.tsx`). 내보내기는 첨부 포함 여부만 고르고 내려받고, 가져오기는 **드라이런을 건너뛸 수 없다** — 파일을 고르면 미리보기(형식·문서 수·**보드와 열 타입**·중복·건너뛴 파일·경고)를 먼저 보여주고 그걸 본 뒤에만 실행 버튼이 열린다. 되돌릴 수 없는 벌크 생성이라 확인 없이 실행할 수 있는 자리를 아예 두지 않았다.

둘 다 **editor** 권한이고 활동 로그(`내보냄`·`가져옴`)를 남긴다. admin 을 걸지 않는 이유: editor 는 어차피 개별 API 로 같은 데이터를 읽고 쓸 수 있으니 여기만 막으면 **회수 경로만 사라지고** 실질 보호는 없다. 통제는 역할이 아니라 기록으로 건다.

- **내보내기**: `GET /api/export` → zip. `docs/<프로젝트>/<제목>.md`(문서 본문) · `boards/<보드>.csv` · `attachments/<파일>`(문서가 참조하는 첨부) · `workspace.json`(구조·메타 + **문서 id↔파일 대응표 `documents[]`**, **보드 대응표 `boards[]` = `{id,title,project,file,properties[{name,type,options?}]}`**, 첨부 대응표 `attachments[]`) · `README.md`. CLI: `pnpm ws export [--out <경로>] [--no-attachments]`.
  - **보드 색인의 `properties`** 가 왕복의 핵이다. CSV 는 타입을 잃어버려서(무엇이 날짜였고 무엇이 select 였는지 알 수 없다) 색인 없이는 되살릴 수 없다 — 행이 한 개인 보드의 select 는 추론으로 절대 못 맞힌다.
  - **첨부(E4)**: 본문의 `/uploads/<ws>/<파일>` 링크는 `../../attachments/<파일>` **상대경로로 바뀌어** 담긴다 — 그래야 서버 없이 옵시디언·VS Code 에서 그림이 보인다. 어느 문서도 참조하지 않는 업로드는 담지 않는다(전체 첨부 백업은 `pnpm backup` 담당). 디스크에서 사라진 첨부는 `workspace.json` 의 `attachmentsMissing` 에 남는다. 첨부를 빼려면 `?attachments=0`. 휴지통 문서는 언제나 빠진다.
- **가져오기**: `POST /api/import` (multipart `file`=zip, 최대 50MB·문서 2000건). 폼 필드 `projectId`(전부 이 프로젝트로 강제) · `createProjects=1`(zip 의 폴더 이름과 같은 프로젝트가 없으면 생성 — 기본은 **만들지 않고 미분류**) · `skipExisting=1`(같은 프로젝트에 같은 제목이 있으면 건너뜀). CLI: `pnpm ws import <zip경로> [--project <id>] [--dry-run] [--create-projects] [--skip-existing]`.
  - **`?dryRun=1` 을 먼저 쓴다.** 수백 건을 만드는 되돌릴 수 없는 작업이라, 생길 문서·프로젝트·건너뛴 파일·중복(`duplicate`)을 실행과 **같은 계산**(`lib/importPlan`)으로 먼저 보여준다.
  - 받는 형식 셋(`format` 으로 응답): `teamspace`(우리 export — `workspace.json` 색인으로 제목·프로젝트를 정확히 복원) · `notion`(파일·폴더명의 32자리 해시를 뗀다) · `markdown`(첫 폴더=프로젝트). 공통 루트 폴더 한 겹은 벗겨내고 경고로 알린다.
  - 제목 우선순위: 색인 > 프론트매터 `title` > 첫 `# h1` > 파일명. 프론트매터는 **본문에 그대로 남는다**(PageEditor 가 보존하므로 떼어낼 이유가 없다). 같은 프로젝트 안에서 겹치면 ` (2)`.
  - **첨부(E4)**: 본문이 가리키는 목적지 중 **zip 안에 실제로 있는 파일**을 첨부로 보고 `public/uploads/<ws>/` 로 복원한 뒤 링크를 새 URL 로 갈아끼운다. `attachments/` 라는 이름을 특별대우하지 않으므로 노션처럼 md 옆에 그림이 놓인 형태도 같은 규칙으로 걸린다. 아무도 참조하지 않는 파일은 이유와 함께 `skipped[]`. 파일명은 `<내용해시8>-<이름>`(`/api/upload` 와 같은 규칙)이라 같은 그림을 몇 번 가져와도 디스크 사본이 늘지 않는다.
  - **문서 계층(E2 후속)**: zip 의 폴더 구조를 그대로 살린다. 프로젝트와 파일 사이의 폴더가 **자식을 가진 doc 페이지**로 만들어지고 `parentId` 로 이어진다(응답 `counts.folders`·`foldersCreated`). 폴더 자리에 같은 이름의 문서가 있으면(노션의 `스펙.md` + `스펙/`) **빈 폴더를 만들지 않고 그 문서를 부모로 재사용**한다 — 안 그러면 문서가 둘로 갈라진다. 문서를 먼저 다 만들고 마지막에 부모를 잇는 순서라 생성 순서 문제가 없다.
  - **보드(CSV) (E2 후속)**: `*.csv` 는 **보드**가 된다(`kind:"database"` 페이지 + 속성 + 행 + `표`/`보드` 뷰). 응답: `counts.boards`·`boardRows`·`boardsCreated`·`boardRowsCreated`, 목록은 `boards[]`(제목·프로젝트·열·행 수·`linkedDocs`). 한 번에 보드 행 5000건, CSV 한 개당 2000행까지.
    - **열 타입**: `workspace.json` 의 `boards[].properties` 가 있으면 그걸 그대로 쓰고(우리 export 왕복), 없으면 값을 보고 추론한다 — checkbox(`Yes/No`·`true/false`·`예/아니오`) → number(`1,200`·`-1.5`; `1/0` 은 숫자다) → date → select → text. **첫 열은 항상 text**(제목 열이 select 가 되면 행마다 옵션이 늘어난다). 확신이 없으면 text 로 남긴다 — text 는 원문을 보관하므로 잃는 게 없다.
    - **읽지 않는 날짜**: `08/09/2026`(월·일 순서를 알 수 없다) · 노션 날짜 범위(`A → B`). 그 열은 통째로 text 가 된다. 읽는 것: ISO · `2026/8/9` · `August 9, 2026`(시각 붙어도 됨) · `2026년 8월 9일`.
    - **multiselect·person·relation 은 만들지 않는다**(text 로 낮추고 경고). 노션의 다중 선택(`"버그, 프론트"`)도 콤마를 보고 text 로 남긴다 — 한 덩어리 옵션으로 만들면 뜻이 망가진다.
    - **노션 데이터베이스**: `Tasks <hash>.csv`(보이던 뷰) + `Tasks <hash>_all.csv`(전체 행)가 함께 오면 **`_all` 만** 쓴다(다른 쪽은 `skipped[]`). 같은 이름 폴더의 행 문서(`Tasks <hash>/행.md`)는 그 행의 본문(`DbRow.contentPageId`)이 되고, 빈 폴더를 만들지 않고 **보드를 부모로** 쓴다. 제목이 같은 행이 둘이면 먼저 나온 행만 문서를 가져간다(`contentPageId` 가 unique).
    - 순수 로직은 `lib/csvBoard.ts`(CSV 파싱·타입 추론·값 변환·`boardRowProps`). select 값은 옵션 **id** 로 저장되고, 옵션 id 를 못 찾으면 이름을 넣지 않고 비운다.
  - 만들지 않는 것: 숨김 파일·`__MACOSX`·미참조 첨부·빈 CSV — 전부 `skipped[]` 에 이유와 함께 남는다.
  - **큰 zip**: `/api/import` 는 **미들웨어 matcher 에서 빠져 있다**(`middleware.ts`). 엣지 미들웨어가 요청 본문을 버퍼링하면서 ~10MB 넘는 multipart 를 깨뜨렸기 때문이다(8MB 통과·10MB 실패 → `Failed to parse body as FormData`). 라우트 첫 줄의 `requireCtx("editor")` 가 본문을 읽기 전에 막으므로 인증은 그대로고, `scripts/authz-coverage.test.ts` 가 "matcher 에서 뺀 /api 경로는 requireCtx 를 쓴다" 를 정적으로 강제한다. 크기는 `content-length` 로 먼저(413), `file.size` 로 다시 본다. **17MB 짜리 우리 워크스페이스 전체 export 왕복을 확인했다**(보드 5개·행 1164건).
  - 순수 로직은 `lib/importPlan.ts`(정규화·형식판별) + `lib/unzip.ts`(zip 읽기 — `lib/zip.ts` 작성기의 짝. CRC 검증·엔트리수·해제총량 상한으로 신뢰 못 할 zip 을 막는다) + `lib/assets.ts`(링크 추출·상대경로 해석·치환·업로드 파일명 — 내보내기·가져오기·업로드 셋이 공유).
- **첨부 서빙**: `GET /api/uploads/<ws>/<파일명>` (`app/api/uploads/[...path]/route.ts`, OSS 후속). 저장 위치는 **레포 밖** — `DATA_DIR/uploads`(`lib/dataDir`: env `TEAMSPACE_DATA_DIR`, 기본 `<cwd>/data`; `.gitignore` 등재). 데이터 루트는 문서·본문 저장소와 **같은 한 곳**에서 정한다 — 첨부만 따로 env 를 읽으면 옮길 때 한쪽만 옮겨진다. 본문에 저장된 링크는 `/uploads/<ws>/<파일>` 그대로 두고 `next.config.ts` 의 **beforeFiles** rewrite 가 이 라우트로 보낸다(afterFiles 면 `public/uploads/` 의 기존 파일이 정적 서빙으로 먼저 나가 인증을 지나친다). CLI: `pnpm ws upload get <url|<ws>/<파일명>> [--out <경로>]`.
  - 왜 라우트로 옮겼나: ① `public/` 정적 서빙은 **인증이 없어서** URL 만 알면 남의 워크스페이스 첨부도 받을 수 있었다(문서에 자물쇠를 달아 두고 그 문서의 그림은 공개였다). ② `public/` 을 빌드 산출물로 다루는 배포에서는 **런타임에 쓴 파일의 서빙이 보장되지 않는다**.
  - 게이트: `requireCtx("viewer")` + **다른 워크스페이스는 404**(403 이 아니다 — 존재도 알리지 않는다) + 경로 가드(`lib/uploadPaths.safeUploadSegments`: 정확히 두 칸·탈출·구분자·제어문자·숨김파일 거절, `uploadFilePath` 로 한 겹 더).
  - 타입: `html`·`js`·`xhtml` 은 **절대 그 타입으로 내보내지 않는다**(같은 출처 저장형 XSS) — 목록에 없는 확장자는 전부 `octet-stream` + `attachment`. 그림·PDF·미디어만 `inline`. `nosniff` + CSP(`svg` 는 `sandbox` 까지, png·pdf 는 내장 뷰어를 죽이지 않도록 스크립트·객체만 차단). 파일명이 내용 해시라 `private, max-age=1y, immutable`.
  - **이미 올라간 파일은 옮기지 않는다.** 읽기는 새 위치 → `public/uploads` 순서로 폴백한다(서빙·내보내기 둘 다). 백업(`pnpm backup`)은 두 위치를 각각 `uploads.tar`·`uploads-legacy.tar` 로 담는다.
- **백업**: `pnpm backup` = Postgres 덤프 + `docs.tar.gz` + **`uploads.tar`(첨부, E4 에서 추가)**. 그 전엔 DB 는 매일 백업되는데 그 DB 가 가리키는 첨부 파일은 아니어서, 디스크를 잃으면 행은 살아 있고 그림만 사라졌다.

## 프로젝트 / 멤버 / 워크스페이스

- 프로젝트: `GET/POST /api/projects` `{ name, short?, color?(blue/orange/purple/green/red/gray), description?, leadId?, repoUrl?, repoPath?, repoBranch?, docsDir? }` · `PATCH/DELETE /api/projects/<id>`. **보관(F10)**: `GET /api/projects` 는 기본 활성만(`?archived=1`=보관함만, `?archived=all`=둘 다), 각 항목에 `archivedAt`(ISO|null). `PATCH {archived:true|false}` 로 보관/해제(기존 edit 게이트; 이미 보관이면 원래 시각 유지). 보관해도 페이지는 그대로고 사이드바엔 `이름 (보관)` 그룹으로 남는다. CLI: `project ls [--archived [all]]` · `project archive|unarchive <id>`.
- 멤버(초대): `GET/POST /api/members`(GET 응답 각 멤버에 `kind:"human"|"agent"` 와, 에이전트면 최신 토큰 요약 `agentToken:{id,name,lastUsedAt,revokedAt}|null` 이 붙는다 — 사람은 항상 null) `{ email, role?(admin/editor/viewer, 기본 editor) }`(이메일로 User find-or-create, 이미 멤버면 409). **POST는 `status:"invited"`로 추가** — 해당 사용자가 로그인하면 `getContext`가 자동으로 `active`로 수락. `PATCH /api/members/<id> {role?, teamId?}`(teamId=null이면 팀 해제) · `DELETE` — **마지막 admin 강등/제거는 차단**(400).
- 팀: `GET/POST /api/teams` `{ name, color?(blue/orange/purple/green/red/gray) }`(GET은 memberCount 포함) · `PATCH /api/teams/<id> {name?, color?}` · `DELETE`(멤버 teamId는 SetNull로 해제). 멤버 배정은 위 `PATCH /api/members/<id> {teamId}`.
- 현재 워크스페이스: `GET /api/workspace` → `{ workspace, role, me, memberCount }` · `PATCH {name}`(admin만, 아니면 403).
- **멀티 워크스페이스**(`pnpm ws workspace …`): `GET /api/workspaces` → `{ workspaces:[{id,name,role,memberCount,current}] }`(내가 속한 active 워크스페이스, `current`=활성) · `POST /api/workspaces {name}`(생성자=admin·active, 생성 후 `ws_active` 쿠키로 전환) · `POST /api/workspaces/switch {workspaceId}`(active 멤버십 검증 → `ws_active` httpOnly 쿠키 설정, 비멤버는 403). 활성 워크스페이스는 `ws_active` 쿠키가 결정(없으면 첫 워크스페이스). 설정 화면(설정 › 워크스페이스 전환)에서도 전환·생성 가능.

## 문서 허브 surface (모두 같은 패턴: GET 목록 / POST 생성 / [id] PATCH·DELETE)

> PATCH 는 **부분 수정**이다 — 넘긴 필드만 바뀐다(`undefined`=건드리지 않음, 빈 문자열=비움). `projectId`에 빈 문자열을 주면 프로젝트 해제, 없는 프로젝트면 400.

| 종류 | 엔드포인트 | 핵심 필드 | 목록 키 |
|---|---|---|---|
| 결정 | `/api/decisions` | title, context?, decision?, status(proposed/accepted/superseded), projectId? | decisions |
| 리스크 | `/api/risks` | title, description?, severity(low/medium/high), status(open/mitigated/closed), projectId? | risks |
| QA | `/api/qa` | title, steps?, expected?, status(pending/pass/fail), projectId? | scenarios |
| 용어집 | `/api/glossary` | term, definition, sourcePageId?(provenance) | terms |
| 변경이력 | `/api/changelog` | version?, title, body?, projectId? | entries(각 항목 `projectId`) |
| 데이터모델 | `/api/entities` | name, description?, fields?, sourcePageId?(provenance) | entities |
| DoD | `/api/dod` | text · `[id]` PATCH `{done?, text?}` (done 토글 + 문구 수정) | items |
| 온보딩 | `/api/onboarding` | title, body? | steps |

변경 이력은 **프로젝트별**(`projectId`, null=공용): `GET /api/changelog?project=<id>`(생략=전체, `none`=공용만 — 볼 수 없는 프로젝트 항목은 `take 200` 이전에 걸러 목록에서 제외), `POST/PATCH` 의 `projectId` 는 이 워크스페이스 프로젝트이면서 호출자가 **편집(edit)** 할 수 있어야 하며 아니면(숨김·보기 전용) 400 `프로젝트를 찾을 수 없습니다.`(PATCH 에서 `""`/null=공용으로 해제), 편집할 수 없는(숨김·보기 전용) 프로젝트 항목의 PATCH·DELETE 는 404. CLI: `changelog ls|add|set --project <id>`.

복원 리허설 기록: `pnpm ws rehearsal record <output-file> [--project <id|auto|none>] [--dry-run]` — `pnpm restore:rehearsal` 출력을 저장한 파일에서 마지막 `---- TeamSpace 문서용 ----` 블록을 뽑아 `POST /api/pages`(제목 `백업 복원 리허설 <YYYY-MM-DD>` — 블록 제목 줄의 날짜, 없으면 오늘 KST · docType `report`) → `PUT /api/pages/<id>`(블록 본문, 제목 줄 제외)로 문서를 만들고 `<id>\t<제목> (PASS|FAIL)` 을 출력한다. 블록이 없으면 에러. `--project` 해석은 changelog draft 와 같다(기본 auto = route-rules, 매핑 없으면 공용 + 경고). 워커는 1·4·7·10월 첫 월요일(서버 로컬)에 워크스페이스마다 사람 관리자에게 받은편지함 알림(type `due`, 제목 `분기 복원 리허설 — pnpm restore:rehearsal 실행 후 ws rehearsal record`, 링크 `/settings`)을 한 번 보낸다 — 중복 방지는 NotifLog `kind=rehearsal_marker`, `text=rehearsal:<YYYY-Qn>`.

변경 이력 초안: `pnpm ws changelog draft [--since <ref|YYYY-MM-DD>] [--project <id|auto|none>] [--dry-run]` — since 이후 feat/fix/perf 커밋을 `POST /api/changelog` 1건(제목 `배포 YYYY-MM-DD`, 버전 `YYYY.MM.DD`·같은 날 `.2`)으로 적재한다. `--since` 가 없으면 앵커는 같은 프로젝트의 **자동 초안 항목**(버전 `YYYY.MM.DD(.N)` + 제목 `배포 …`) 중 가장 최근 `releasedAt` 이고, 프로젝트 항목이 0건이면 공용 항목으로 폴백하며(버전 번호는 두 목록의 합집합으로 센다), 그것도 없으면 7일 전이다. `--since` 가 `-` 로 시작하면 거부. `--project` 기본 `auto` 는 `GET /api/route-rules` 에서 cwd 를 경로 세그먼트 접두사로 가장 길게(동률은 priority) 맞는 규칙의 프로젝트(워크트리 `…/teamspace-x` 는 `…/teamspace` 규칙에 걸리지 않음)이며, 매핑이 없으면 공용으로 적재하고 `프로젝트 매핑 없음 — 공용 변경 이력으로 적재` 한 줄을 경고한다. `none`=명시적 공용, `<id>`=그 프로젝트. 본문 첫 줄은 `기간: <since> ~ <오늘>`, 불릿은 50개 상한 + `… 외 N건`. `--dry-run` 은 해석된 프로젝트와 앵커 출처(`프로젝트 엔트리|공용 엔트리(폴백)|7일`)를 출력만 하고 적재하지 않는다. `deploy.sh` 가 끝에서 인자 없이(=auto) 비치명적으로 자동 호출 — 토큰 없으면 `토큰 없음 — 초안 생략`, git 실패는 `git 사용 불가 — 초안 생략`(exit 0), API 는 10초 타임아웃이고 실패 시 한 줄 + exit 1.

- 필터: `/api/decisions·risks·qa` 는 `?projectId=<id>` 지원. `/api/schedules` 는 `?databasePageId=<id>`.
- **추출→병합 제안**(B2 추출 파이프라인): 문서 본문을 LLM(`lib/llm.complete`)으로 추출해 기존과 대조한 제안을 반환(**자동 기록 안 함**, 검토 단계). 순수 로직 `lib/extract.ts`. LLM 미설정 시 503.
  - 용어: `POST /api/glossary/extract {pageId}` → `{ ok, sourcePageId, proposals:[{term,definition,status(new|duplicate|conflict),existingId?,existingDefinition?}] }`. 수락 `POST /api/glossary {term,definition,sourcePageId}`. `pnpm ws glossary extract <pageId>`. 용어집 화면 "문서에서 추출".
  - 엔티티: `POST /api/entities/extract {pageId}` → `proposals:[{name,description,fields,status,existingId?,existingDescription?}]`. 수락 `POST /api/entities {name,description?,fields?,sourcePageId}`. `pnpm ws entity extract <pageId>`. 데이터모델 화면 "문서에서 추출".
  - 완료 기준: `POST /api/dod/extract {pageId}` → `proposals:[{text,status(new|duplicate),existingId?}]` (본문이 곧 항목이라 conflict 는 나오지 않는다). 수락 `POST /api/dod {text}`. `pnpm ws dod extract <pageId>`. DoD 화면 "문서에서 추출".
  - 온보딩: `POST /api/onboarding/extract {pageId}` → `proposals:[{title,body,status,existingId?,existingBody?}]` (제목 일치 + 본문 상이 → conflict). 수락 `POST /api/onboarding {title,body}`, conflict 는 `PATCH /api/onboarding/<existingId> {body}`. `pnpm ws onboarding extract <pageId>`. 온보딩 화면 "문서에서 추출".
  - QA: `POST /api/qa/extract {pageId, projectId?}` → `proposals:[{title,steps,expected,status,existingId?,existingSteps?,existingExpected?}]`. `projectId` 를 주면 그 프로젝트 시나리오하고만 대조(없는/남의 프로젝트면 400). 수락 `POST /api/qa {title,steps,expected,projectId?}`, conflict 는 `PATCH /api/qa/<existingId> {steps,expected}`. `pnpm ws qa extract <pageId> [--project <id>]`. QA 화면 "문서에서 추출".
  - UI 공통 껍데기는 `components/ws/ExtractPanel.tsx`(문서 선택→추출→제안 검토→항목별 반영). 용어집·데이터모델 화면은 아직 각자 구현을 쓴다.
- **provenance 태깅**(주장 신뢰도, 키리스): `POST /api/provenance {pageId}` → 로컬 LLM 으로 문서의 핵심 주장을 **추출/추론/모호**로 분류 → `{ ok, claims:[{claim,tag,note}], counts:{추출,추론,모호} }`. 순수 로직 `lib/provenance.ts`(buildProvenancePrompt·parseProvenance·countTags). `pnpm ws provenance <pageId>`. LLM 미설정 시 503. 문서 리더의 "신뢰도 분석" 패널.
- **웹 클리퍼**(키리스 자동 분류·요약): `POST /api/clip {url, title?, text, html?}` → 로컬 LLM 으로 본문 요약 + 기존 프로젝트 자동 분류 → 출처 포함 doc 페이지 생성(분류된 projectId 배정) → `{ ok, pageId, projectId, projectName, summary, mode("classified"|"plain") }`. LLM 없으면 원문만 저장(plain). 순수 로직 `lib/clip.ts`(buildClassifyPrompt·parseClassification). `pnpm ws clip <url> --text "<본문>" [--title <t>]`. 브라우저 진입점은 북마클릿(`/clip` 페이지로 수집 데이터 전달, 동일 출처 POST).
- 부가: `GET /api/lint`(깨진 링크·고아).

- **검색**: `GET /api/search?q=&projectId=&kind=doc,board,decision&from=&to=&limit=` — 랭킹(제목 정확일치 > 앞부분 > 포함 > 본문 다수 > 본문 1회 + 최근 수정 약가산)은 `lib/searchRank.ts`(순수). 응답 `{q, indexed, total, results[], docs[], decisions[]}` — `results` 가 통합 랭킹, `docs/decisions` 는 기존 화면 호환용. **`indexed:false` = 질의가 3글자 미만이라 트라이그램 인덱스를 못 탔다**(순차 스캔). 인덱스는 `pg_trgm` GIN(마이그 `20260808140000`). `projectId=__none__` 은 미분류만. **공백 변형 매칭**: 3~12자 무공백 질의("인증코어")는 한 칸 삽입 변형("인증 코어")까지, 공백 있는 질의는 공백 제거본까지 OR 로 찾는다(원문 일치가 항상 위, `lib/searchVariants.ts`). 화면 `/search?q=` 딥링크는 입력창에 채워진다. CLI: `ws search <q> [--project|--kind|--from|--to|--limit]`. `&neighbors=1` 을 붙이면 상위 5개 결과에 `neighbors:[{id,title,type,kind,tag}]`(지식 그래프 이웃, 각 ≤5, 권한 필터 적용)가 붙는다 — MCP `search` 는 기본으로 쓴다.
- **비동기 LLM 잡**(범용 큐, editor 이상): `POST /api/llm/classify {kind, payload, callbackUrl, callbackSecret?}` → 즉시 `202 {jobId}`, 실제 처리는 워커(`dispatchLlmJobs`, `lib/llmjob.ts`)가 맡아 완료 후 `callbackUrl` 로 `{jobId,kind,ref,ok,result}` POST(Bearer `callbackSecret`, 있으면). 현재 지원 kind: `feedback_classify`(`payload:{ref,body,agendas:[{id,title,summary?}]}`). `pnpm ws llm classify --body <텍스트> --callback <url>`(디버그용 최소 명령 — callback 필수, 결과가 원문 포함으로 그 URL에 POST되므로 신뢰할 수 있는 수신처만).
  - **콜백 URL 은 SSRF 게이트를 지난다**(`lib/callbackUrl.ts`, 피드백허브 후속). 서버가 남이 준 주소로 요청을 보내는 기능이라 검사가 `^https?://` 하나였던 것을 고쳤다. 막는 것: http(s) 아닌 스킴 · `user:pw@` 자격증명 · 제어문자 · 루프백·사설망·링크로컬(169.254 메타데이터)·CGNAT(=tailscale 100.64/10)·IPv6 사설 · `.local`/`.internal`/`localhost` 계열 · **8진수·16진수·정수로 위장한 IP**(`http://2130706433/` = 127.0.0.1). **검사는 접수(라우트)와 발송(워커) 양쪽**에서 한다 — 한쪽만 막으면 이미 쌓인 행이 나가거나 부른 쪽이 거절을 모른다. 안 하는 것: **DNS 해석**(공격자 도메인이 사설 IP 를 가리키는 rebinding 은 allowlist 를 설정해야 닫힌다).
  - **이 배포에서는 `LLM_CALLBACK_ALLOWED_HOSTS=callback.example.com` 이 `.env` 가 아니라 launchd plist 의 `EnvironmentVariables` 에 있다**(`~/Library/LaunchAgents/com.teamspace.{web,worker}.plist`, 2026-08-10). 에이전트는 `.env` 쓰기가 권한 규칙으로 차단돼 있어서 그 경로를 썼다 — **값을 찾을 때 `.env` 만 보면 없다.** 바꾸려면 plist 를 고치고 `launchctl bootout` → (수 초 대기) → `bootstrap`. 두 명령을 붙여 치면 경합으로 `Bootstrap failed: 5` 가 나고 서비스가 내려간다(겪었다; 재시도로 복구).
  - 환경변수 2개(`lib/llmjob.callbackPolicy`): `LLM_CALLBACK_ALLOWED_HOSTS`(콤마 구분 호스트. 하위 도메인 포함 허용. **비면 "내부 차단만"** 이라 기존 공개 콜백은 그대로 동작한다. 실제 수신처는 `callback.example.com` 하나다) · `LLM_CALLBACK_ALLOW_PRIVATE=true`(로컬 개발에서 자기 서버로 콜백받을 때만).
  - **콜백이 실패해도 `result` 는 저장한다.** 전엔 `result: ok ? … : undefined` 라 파싱까지 끝난 분류를 버렸고, 재시도마다 같은 프롬프트로 LLM 을 다시 불렀다(콜백 쪽 장애 = 같은 분류를 3번 과금). 이제 `result` 가 있으면 LLM 을 건너뛰고 재전송만 한다. 콜백 게이트에 걸린 잡은 재시도해도 달라질 게 없으니 attempts 를 태우지 않고 즉시 `failed`.
  - **보관 30일**: 워커가 한 시간에 한 번 `purgeOldLlmJobs()` 로 `done|failed` + `updatedAt` 30일 경과 행을 지운다(`JOB_RETENTION_DAYS`). payload 에 사장님 원문이 들어 있어 영구보관할 이유가 없다.

### 지식 그래프
- `GET /api/graph?types=&kinds=&project=<id>&hops=1|2` — 노드(doc·project·decision·lesson·task·risk) + 간선(link·ref·contains=추출 / mention·pair=추론 / related=모호). `project` 를 주면 그 프로젝트 소속 노드에서 `hops`(기본 1, 1|2 외 400) 홉 안의 조각만(없는 id 면 빈 그래프). 빈 `hops=` 는 생략과 같아 기본 1, `hops=0` 이나 2 초과는 400, `project` 없이 `hops` 만 주면 무시한다. CLI `pnpm ws graph [--types][--kinds][--project <id> [--hops 2]]`.
- `GET /api/graph/neighbors?id=&depth=1|2` — 이웃. CLI `pnpm ws graph neighbors <id>`, MCP `graph_neighbors`. 문서를 통째로 읽기 전에 먼저 본다.
- 권한: 볼 수 없는 것은 그래프에 없다(404).
- 캐시: 권한은 정확(권한 지문 기준), 내용은 ≤60 s(페이지 쓰기 시 무효화).
- 응답: neighbors → `{node, neighbors:[{id,title,type,href,kind,tag,direction,hop}]}` — hop 2 의 kind/direction 은 중간 노드 기준. infer → `{ok, processed:[{id,title,related:[{id,title,reason}]}], remaining, skippedTried}`.
- `/api/context` compact 에 `## 지식 지도`(허브 id·커뮤니티)가 들어간다 — 그래프 로드가 800 ms 를 넘으면 생략.
- `POST /api/graph/infer {limit,dryRun,retry?,retryBefore?}` — 근거 없는 문서에 LLM 연관(related, 모호). 후보는 볼 수 있는 문서 중 TF-IDF 유사도 상위 ≤60(모자라면 제목순 채움). CLI `pnpm ws graph infer --limit 5 --dry-run` 으로 먼저 보고 `--all`. `--limit` 기본 5·1..20(범위 밖은 잘라서 쓰고, 숫자가 아니면 400), `--all` 은 남은 게 없을 때까지 반복. **추론은 문서당 1회만(`Page.inferTriedAt`, 연관을 못 찾아도 표시). 다시 돌리려면 `--retry`(실행 시작 이전에 시도한 문서만 다시 — API 는 `retryBefore` ISO 시각, `retry:true` = 지금)**. 재시도는 LLM 응답 캐시를 우회한다(같은 프롬프트라도 새로 묻는다). `exclude` 는 받아서 무시한다.

## 모바일 (격차 F2)

기존 `@media` 는 사이드바를 드로어로 바꾸는 **구조**만 다뤘다(그래서 폭 넘침은 원래 없었다). F2 에서 채운 건 **손으로 쓸 수 있는가**: 탭 타겟 40px+(사이드바 35→40, 햄버거 44), **입력 글자 16px**(그 미만이면 iOS 사파리가 포커스 시 화면을 확대해 버린다), 안전영역(노치·홈 인디케이터), 표·칸반 관성 스크롤+스냅, 표 첫 열 고정, 드로어 전체 폭, 폰에서 밀도 컨트롤 숨김. 터치 판정은 폭이 아니라 `(hover: none) and (pointer: coarse)` 로도 본다(호버로만 보이던 버튼은 터치에서 영영 안 보인다).

⚠️ `.ws-main > :first-child` 같은 **일반 선택자로 위쪽 여백을 주지 말 것** — 각 화면이 이미 햄버거를 피할 여백(`.ws-db { padding: 60px … }`)을 갖고 있어서, 덮으면 제목이 햄버거 밑으로 들어간다(실제로 겪음). 검증은 같은 출처 iframe 을 390px 로 띄워서 한다(창 리사이즈가 안 먹는 환경이 있고, iframe 은 자체 뷰포트라 미디어쿼리가 정상 적용된다).

## PWA·오프라인 (격차 F1)

- `app/manifest.ts` → `/manifest.webmanifest`(설치형, `start_url=/dashboard` — 루트는 첫 페이지로 넘기는 경유지라 설치 아이콘이 남의 문서로 들어가면 안 된다) · 아이콘 `public/icons/*`(192·512·maskable·apple-touch).
- 서비스 워커 소스는 `app/sw.js/worker.js`, 서빙은 `app/sw.js/route.ts`(버전 주입). **`public/` 에 두면 안 된다** — 정적 파일이 같은 경로의 라우트를 가려 버전이 안 박힌 원본이 서빙된다(실제로 겪음).
- **워크스페이스 데이터는 절대 캐시하지 않는다.** `/api/*` 는 워커가 손대지 않는다 — 낡은 태스크 상태는 없느니만 못하다. 캐시는 ① 불변 정적 자산 ② `/offline` 안내뿐이고, 화면(HTML)은 네트워크 우선.
- **킬 스위치**: 주소에 `?sw=off` → 등록 해제 + 캐시 삭제 + **그 선택을 기억**(localStorage `ws-sw`), `?sw=on` 으로 복귀. 기억하지 않으면 다음 방문에 곧바로 재등록돼 탈출구가 되지 못한다(검증 중 확인).
- 미들웨어 matcher 에서 `sw.js`·`manifest.webmanifest`·`icons`·`offline` 을 제외한다 — 워크스페이스 데이터가 없고, 로그인 리다이렉트가 걸리면 워커 등록이 MIME 오류로 실패한다.

## 키보드

- **커맨드 팔레트: `Cmd/Ctrl+K`** — 문서·보드로 이동하거나 화면(검색·대시보드·프로젝트·설정 등)을 연다. `↑↓` 이동 · `⏎` 열기 · `esc` 닫기 · `Ctrl+N/P` 도 이동. 매칭·랭킹은 `lib/palette.ts`(순수): 연속 부분문자열이 1순위, 흩어진 글자(subsequence)가 2순위, 순서가 어긋나면 안 잡는다. 후보는 팔레트를 열 때 `/api/pages` 를 한 번만 받아 클라이언트에서 거른다.

## MCP 서버 (W8 — 네이티브 접점)

- **이 레포의 `.mcp.json`이 `teamspace` MCP 서버를 자동 등록** — **22개 툴** 제공(`scripts/mcp-server.ts`): `context_get`(기본 압축본 `compact=1` ≈10KB, `full:true` 일 때만 전체 100KB+) · `task_list/claim/update/add/move` · `board_get` · `doc_list/read/save/create/comment` · `lesson_list/get/add` · `decision_add` · **`propose`** · `inbox_list` · `activity_list` · `search` · `site_list/publish`(HTML 퍼블리시). (종전 이 목록에 `propose` 가 빠져 있었다 — `scripts/mcp-server.test.ts` 가 이제 도구↔라우트 패리티를 검증한다). 다른 레포/머신: `claude mcp add teamspace -- pnpm --dir <레포경로> exec tsx scripts/mcp-server.ts`. 인증은 `~/.claude/teamspace.json`.
- MCP 툴이 있으면 그걸 우선 사용, 없으면 이 스킬의 CLI/raw API 로.
- **멱등성**: `Idempotency-Key` 헤더를 지원하는 POST 는 정확히 이 7개다 — `databases/<id>/rows` · `pages` · `pages/<id>/comments` · `rows/<id>/comments` · `schedules` · `approvals` · `proposals`. 재시도 시 같은 키를 보내면 이중 생성 없이 저장된 응답을 돌려준다. (열거가 모호해 행 댓글이 빠진 걸 아무도 몰랐다 — 2026-08-07 지원 추가 + 목록 정정)
- **이벤트 푸시(W8)**: `GET /api/events` SSE(브라우저 쿠키 전용) — UI 자동 갱신이 이벤트 기반. 에이전트는 폴링/MCP 유지.
- **토큰 체인(W8)**: ws CLI·훅·MCP 모두 `WS_TOKEN` > `~/.claude/teamspace.json`. 레거시 공유 토큰은 폐기 완료 — 항상 에이전트 토큰(wst_)만 쓴다. 새 에이전트/머신은 `pnpm ws token add <이름>` 발급 후 teamspace.json 에 저장.

## Claude가 워크스페이스를 읽기 (AI 연결)

- `GET /api/context?format=md|json&cwd=<path>` → 워크스페이스를 **Claude가 읽는 Markdown 스냅샷**으로(**팀 레슨**·보드 열린 태스크·문서·승인된 결정·열린 리스크·용어집). `cwd`를 주면 라우트룰로 프로젝트를 해석해 그 프로젝트 우선 필터. `format=json`은 `{ markdown, counts }`. `pnpm ws context`.
- **자동 주입(W3)**: SessionStart 훅(`scripts/hooks/teamspace-context.mjs`, 전역 사본 `~/.claude/hooks/`)이 매 세션 시작 시 위 스냅샷을 주입하고 세션 시작을 `/api/ingest`에 기록, SessionEnd 훅이 종료를 기록한다. 인증은 `~/.claude/teamspace.json` `{base, token}`(에이전트 토큰) — 팀원 머신도 같은 파일로 참여.
- **레슨(팀 작업규칙)**: `GET /api/lessons[?projectId=&q=&limit=]`(q=제목 부분일치·대소문자 무시, limit 1..300 — 생략하면 전체, 응답 `{ lessons, total }` 의 total 은 limit 앞 건수) · `POST /api/lessons {title, body, projectId?}` · `GET/PATCH/DELETE /api/lessons/<id>`. CLI: `pnpm ws lesson add|ls|show|set|rm` (`lesson ls --q <제목> --limit n`; `lesson set <id> --project <id>|--global` 로 범위 변경). MCP: `lesson_list { projectId?, q?, limit?(기본 100, 최대 300) }`(id·제목·범위 색인만, 응답 `{ total, shown, lessons }`) · `lesson_get`(전문) · `lesson_add`.
  - **범위를 정확히 붙인다(셋 중 하나)**: ① **프로젝트** — 그 레포에서만 의미 있는 것(로요 마이그레이션·결제 등) `projectId` ② **스택** — 특정 기술(next·supabase…)을 쓰는 프로젝트에만 해당하는 것 `stack` (예: Next 16 proxy 헤더) ③ **전역** — 둘 다 비움, **모든 레포 세션**에 들어가므로 진짜 공통 규범만. API 는 projectId·stack 동시 지정을 400 으로 거절하고, 한쪽을 새로 정하면 다른 쪽을 비운다. CLI: `lesson add|set … --project <id> | --stack <tag> | --global`.
  - **스택 레슨이 들어가는 조건**: 세션 cwd 가 프로젝트로 매핑되고(`route-rule`) 그 프로젝트의 `Project.stack` 에 태그가 있을 때. 프로젝트 스택은 `pnpm ws project set <id> --stack next,supabase` / `PATCH /api/projects/<id> {stack}`. 매핑이 안 되거나 스택이 안 맞아 뺀 스택 레슨 수는 주입 끝에 적힌다.
  - **주입 방식(2026-09-15 개편, `lib/lessonInject.ts`)**: 세션 훅은 `/api/context?compact=1` 을 부른다. 레슨은 `### 프로젝트: <이름>` / `### 스택: <tag>` / `### 전역` **섹션으로 나뉘고 섹션별 예산**(합 5000자, 필요량이 적은 섹션부터 채우고 남는 몫을 넘김)을 받는다. 커버리지 우선 — 먼저 전부 제목 줄로 담고 남는 만큼 최근 것부터 `제목 — 처방 요약 \`id\`` 로 올리며, 넘친 개수는 `… 외 N개` 로 **항상 표시**한다. 요약은 본문의 `처방`/`교훈` 부분을 우선한다(없으면 첫 '실사례(...)' 문장을 건너뜀). 나머지 섹션도 compact 에선 상위 N건 + `외 N건`, 용어집은 용어명만. 전체 ~9KB.
  - **계정 줄(env 금고 P3c, `lib/envVault/sessionAccounts.ts`)**: cwd→프로젝트에 env 금고 반영 대상(EnvTarget)이 있고 프로젝트를 볼 수 있으면, compact 출력 머리말 바로 뒤(레슨 앞)에 `## 계정 (env 금고 반영 대상)` + 종류별 1줄(aws > vercel > gha > dotenv, 중복 제거, 최대 3줄·≤300자, 경로 $HOME→~)을 넣는다 — 예 `- AWS: 계정 123456789012 · 프로필 acme (SSM /acme/dev·/acme/prod)`. 이 글자 수는 레슨 예산(restChars)에서 빠진다. brief 는 가장 중요한 1줄만. 대상이 없으면 출력은 종전과 바이트 단위로 같다(`app/api/context/__fixtures__/compact-no-targets.golden.txt`). 변수 이름·값은 넣지 않는다. 미리보기: `pnpm ws env target ls <project>` 끝의 "세션 주입 미리보기".
  - **source 별 모드(brief)**: 훅은 stdin `source` 로 모드를 고른다 — `startup`·`clear`(·없음)=전체(`compact=1`, 세션 시작 ingest 기록), `resume`·`compact`=요약(`&brief=1`, ingest 생략). `brief=1` 은 ~2.5KB(`lib/contextBrief.ts`, 바이트 예산): 헤더 + 프로젝트·스택 레슨 **제목·id 만**(전역은 개수만 `전역 N건 — MCP lesson_list`) + 열린 태스크 **내 담당(진행 중 먼저) + 그 밖 진행 중 상위 5건** + 나머지 섹션 한 줄 집계(`문서 N · 결정 N · 리스크 N · 용어 N · 지식 지도 — MCP context_get`). 지식 지도 그래프는 로드하지 않는다. `compact=1` 과 같이 오면 brief 우선, `format=json` 형태(`{ markdown, counts }`)는 같다. 출력 태그는 `<teamspace-context source="<base>" mode="full|brief">`.
  - **왜**: 종전엔 take:50 + 프로젝트 우선 정렬로 전역 레슨이 조용히 잘렸고(로요 cwd 에서 27개 누락), 본문 통째 주입으로 53KB 가 되어 **Claude Code 가 훅 출력을 파일로 빼고 앞 2KB 미리보기만 넣었다** — 실제로 읽힌 레슨은 두세 개였다. 본문 속 `##` 제목도 섹션을 깨서 `▸` 로 바꾼다. `compact` 없이 부르면(AI 연결 화면·내보내기) 전체를 섹션 분리해 보여준다. UI: 문서 허브 › 팀 작업규칙 탭. 컨텍스트 주입 최상단에 포함되므로 "팀원 전원의 에이전트가 알아야 할 규범"은 반드시 레슨으로 승격.
  - **레슨 주입 점검(설정 › 레슨 주입 점검, 편집자 이상)**: 어떤 레슨이 요약·제목만·잘림으로 들어가는지, 어느 cwd 가 프로젝트에 안 붙는지, 주입이 실제로 일어났는지 본다.
    - `GET /api/lessons/inspect?projectId=|cwd=` → `{ resolved:{resolution(cwd|project_rule|project_unmapped|none),cwd,projectId,projectName,projectStack}, budget:{contextBudget,lessonMinBudget,lessonBudget,lessonChars,restChars,totalChars}, sections:[{kind(project|stack|global),tag,count,budget,used,gist,title,omitted}], preview(주입되는 레슨 섹션 그대로), statusCounts, lessons:[{id,title,scope,projectId,projectName,stack,status(gist|title|omitted|not_applicable),reason(other_project|stack_mismatch)}], linkChecks:{windowDays,unmappedCwds,emptyStackProjects,orphanStackLessons,brokenRouteRules}, projects }`. 시뮬레이션은 `/api/context` 핸들러를 `inspect=1`(기록 안 함, JSON 에 `lessonReport` 동봉)로 불러 **실제 주입과 같은 함수**(`buildLessonSection`)로 만든다. `projectId` 만 주면 그 프로젝트로 해석되는 route-rule 의 cwd 를 쓰고, 규칙이 없으면 `project_unmapped`(실제로는 주입 안 됨, 추정치).
    - `GET /api/lessons/injections?days=30`(1~90) → `{ days, totals:{injections,last7,reads}, byProject:[{projectId,projectName,last7,lastN}], recent(20), lessons:[{id,title,scope,gist,titleOnly,omitted,reads}], cleanup:{alwaysTruncated(compact 기록 기준),neverInjected,similarTitles(자카드≥0.6)}, truncated }`.
    - **기록**: `/api/context` 가 `compact=1`·`brief=1` 요청마다 `LessonInjection` 1행(actor·cwd·projectId·via·mode·gist/title/omitted id·전체 글자 수, 본문 없음). 훅은 `&via=SessionStart`(teamspace-context.mjs) / `&via=PostToolUse`(teamspace-project-context.mjs) 를 붙이고, 없으면 `unknown`. 에이전트의 `GET /api/lessons/<id>` 는 `LessonRead` 1행. 둘 다 90일 보관(워커·기회적 정리), `LESSON_INJECTION_LOG=off` 면 기록 안 함.
    - CLI: `pnpm ws lesson inspect [--cwd <path>|--project <id>] [--md]`, `pnpm ws lesson injections [--days N]` — 한국어 요약.
- **승격 제안 큐**: `GET/POST /api/proposals {kind(lesson|decision), title, body, projectId?}` · `PATCH /api/proposals/<id> {action: approve|reject, note?}`(admin — approve 시 레슨/결정 자동 생성) · `DELETE`(본인 pending 철회). CLI: `proposal ls|add|approve|reject`. MCP: `propose`. **세션에서 배운 팀 규범·확정 사항은 세션이 끝나기 전에 lesson_add(확신+admin) 또는 propose(검토 필요)로 남긴다** — admin에게 인앱 알림, 결과는 제안자에게 알림. UI: 팀 작업규칙 탭 상단 대기 목록.
- **라우트룰(cwd→프로젝트)**: `GET /api/route-rules {cwdPrefix, projectId?, priority?}`(인증만) · `POST`(**editor** — 설치기 재실행이 페어링 발급 editor 토큰으로 호출하므로 admin→editor 완화) · `DELETE /api/route-rules/<id>`(admin 유지). CLI: `pnpm ws route-rule add|ls|rm`.
- AI 연결 화면(`/aiconnect`)이 이 스냅샷 미리보기·복사·`.md` 내보내기 + 연결 방법(이 스킬·`pnpm ws`·읽기 API·file-first `docs/*.md`)을 보여준다. 세션 탐색기(M4 `/api/sessions`·`/api/ingest`)는 보조.
- **Vault Q&A**: `GET /api/ask?q=<질문>` → 문서·결정 본문에서 근거 패시지를 찾아 답한다. `{ question, answer, mode("llm"|"extractive"|"empty"), sources:[{id,title,kind(doc|decision),passage,heading}] }`. 랭킹 순수로직 `lib/ask.ts`(tokenize·scorePassage·rankSources), 합성 `lib/llm.ts`. UI: 검색 화면의 "물어보기" 토글. `pnpm ws ask "<질문>"`.
  - **벡터 유사도(격차 G2)**: `GET /api/search/similar?pageId=<id>` (이 문서와 비슷한 문서) 또는 `?q=<질의>`. 순수 로직 `lib/vector.ts`(TF-IDF + 코사인, 한글은 2글자 n-gram 보조, 제목 가중 3배). **신경망 임베딩이 아니다** — 응답의 `method: "tfidf-cosine"` 이 그 사실을 밝힌다. 글자가 안 겹치는 동의어("환불"↔"리펀드")는 못 잇고 그건 아래 개념검색이 맡는다. 대신 **질의어 없이 문서 자체로 이웃을 찾는 것**이 여기서만 된다. 색인은 요청마다 만든다(수백 건 규모에선 수십 ms, 대신 방금 고친 문서가 바로 반영된다). D3 로 못 보는 문서는 색인에서 제외. UI: 문서 리더 하단 "비슷한 문서". CLI: `pnpm ws similar <pageId>` / `--q "<질의>"`. *진짜 임베딩은 외부 임베딩 API 키가 필요해 보류 — `vectorize()` 만 갈아끼우면 되도록 갈라 뒀다.*
  - **개념 검색**(임베딩 없이 키리스): `GET /api/search/concept?q=` → 로컬 LLM(`lib/llm.complete`)으로 검색어를 동의어·연관 개념으로 확장한 뒤 합집합 토큰으로 본문 검색·랭킹 → `{ query, expanded[], terms[], mode("expanded"|"plain"), results:[{id,title,kind,passage,heading}] }`. LLM 없으면 원 토큰만(plain)으로 graceful. 순수 로직 `lib/semsearch.ts`(parseExpansion·mergeTerms). `pnpm ws concept "<검색어>"`. (진짜 벡터 임베딩 B4 는 외부 임베딩 API 필요 — 이건 그 키리스 대안.)
  - **LLM 프로바이더**(`ASK_LLM_PROVIDER`=api|cli|off, 기본 자동): `api`=`ANTHROPIC_API_KEY`로 Anthropic API(모델 `ANTHROPIC_MODEL` 기본 sonnet-4-6). `cli`=**키 없이** 로컬 `claude` CLI 헤드리스(`-p`, 툴 비활성·1턴, 모델 `ASK_CLAUDE_MODEL` 기본 haiku-4-5, 타임아웃 `ASK_CLAUDE_TIMEOUT_MS` 기본 **120s**(lib/llm.ts:25 — 문서엔 30s 로 적혀 있었다))로 기존 Claude Code 로그인 사용. 자동 결정: 키 있으면 api, 없으면 cli(바이너리 부재 시 추출형 폴백). 어느 경로든 실패하면 `mode=extractive` 발췌로 안전 폴백.
  - **기능별 모델·max_tokens**(`lib/llmPolicy.ts`): `feature` 가 `ask` 면 **합성** 등급, 그 외(미지정 포함)는 전부 **추출** 등급. 모델 env —
    | env | 등급 | 기본 |
    |---|---|---|
    | `ANTHROPIC_MODEL` | api 합성 | `claude-sonnet-4-6` |
    | `ANTHROPIC_MODEL_EXTRACT` | api 추출 | `claude-haiku-4-5` |
    | `ASK_CLAUDE_MODEL` | cli 합성(추출 기본값도) | `claude-haiku-4-5` |
    | `ASK_CLAUDE_MODEL_EXTRACT` | cli 추출 | `ASK_CLAUDE_MODEL` → `claude-haiku-4-5` |
    | `LLM_CACHE=off` | 응답 캐시 끔 | 켜짐 |
    | `LLM_DAILY_BUDGET_TOKENS` | 하루 토큰 예산(전 워크스페이스 입력+출력, 서버 로컬 날짜). 넘으면 캐시 미적중 호출을 막고 `LlmCall` 에 `errorKind:"budget_exceeded"` 행(시간 0)만 남긴 뒤 null(호출부는 추출형 폴백/503). 0·없음=끔. `LLM_CALL_LOG=off` 면 집계가 없어 예산이 적용되지 않는다(경고 1회) | 0(끔) |

    max_tokens(api 경로만 — CLI 는 상한 플래그 없음): ask 700 · feedback-classify 600 · search-concept 300 · graph-infer 800 · provenance 500 · clip 800 · `*-extract`·기본 1500.
  - **응답 캐시**(`lib/llmCache.ts`, 모델 `LlmCache`): 키 = sha256(provider·model·system·prompt[·workspaceId]) — 워크스페이스를 아는 호출은 id 가 키에 섞여 워크스페이스끼리 응답을 공유하지 않고(행에 `workspaceId` 저장), 프롬프트는 해시만, 값은 응답 텍스트·응답 모델. 적중이면 실제 호출 없이 반환하고 `LlmCall` 에 `provider:"cache"`(시간 0·토큰 null) 1행. 성공(빈 응답 아님)만 저장, 실패는 저장 안 함. 호출별 끔: `complete(prompt, { cache: false })`. 마지막 적중 30일 지난 행은 워커가 정리. 워크스페이스 삭제를 맡는 중앙 경로가 아직 없어(`deleteLlmCacheForWorkspace` 는 준비만 — 워크스페이스 DELETE 라우트가 생기면 거기서 호출) 삭제된 워크스페이스의 파생 텍스트는 최대 30일 남는다. `LOG_LEVEL=debug|info|warn|error`(기본 info)로 로그 수준을 거른다. 모든 호출은 `lib/llm.ts` 의 `tracked()` 한 곳을 지난다(정책→캐시→예산→호출→기록→저장).
  - **LLM 호출 기록**: `lib/llm.ts` 의 `complete`·`synthesizeAnswer` 는 호출마다 `LlmCall` 1행(workspaceId·feature·provider·model·ok·errorKind·durationMs·토큰)을 fire-and-forget 으로 남긴다 — **프롬프트·응답 본문은 저장하지 않음**, 기록 실패는 호출측에 영향 없음. 새 호출처는 `complete(prompt, { feature: "<라벨>", workspaceId })` 로 라벨을 붙인다(문자열 두 번째 인자는 종전처럼 system). 토큰은 api(응답 usage)·cli(`--output-format json` 결과의 usage) 모두 캐시 입력 포함으로 남긴다 — cli 출력이 JSON 이 아니면 평문으로 받고 토큰 null(json 전환 전 행도 null). cli 실패 분류는 결과의 `subtype`(예 `error_max_turns`)·`is_error`. 비용(`total_cost_usd`)은 저장하지 않는다. 90일 지난 행은 워커·집계 때 정리. `LLM_CALL_LOG=off` 로 끔.

## AI 실행 경로 (관리자 — 사용처·사용량·외부 중계 상태)
- `GET /api/ai-routes?days=7`(사람 세션 **admin** · 에이전트 토큰 **editor 이상** — env 금고 pull 과 같은 하한이라 `pnpm ws ai-routes` 가 editor 에이전트 토큰으로 동작, 1~30일, `Cache-Control: no-store`) → `{ days, relay:{configured,label,status,usage,usageError}, teamspace:{totals,byDay,byFeature,byProvider,errorKinds,provider,models:{synthesize,extract}|null,cacheHits}, cost:{todayTokens,todayUsd,periodUsd,budgetTokens,exceeded,cacheHits}, routes:[{name,kind(relay|api|cli),calls,ok,inputTokens,outputTokens}] }`. cli 경로 토큰은 기간 안에 기록된 행이 없으면 null(— 표시). teamspace 는 이 워크스페이스의 LlmCall 집계 — totals·byDay·byFeature·byProvider 의 `calls`·ok·failed·토큰·avgMs·p95Ms·usd 는 **실제 호출만**(캐시 적중 제외) 세고, 각 항목의 `cacheHits` 가 캐시 적중(`provider:"cache"` 행) 수다(byProvider 의 `cache` 항목은 calls 0·cacheHits=행 수). 상단 `teamspace.cacheHits`·`cost.cacheHits` = `totals.cacheHits`, relay 는 머신 단위. routes 표는 api/cli 만(캐시 적중은 경로가 아님).
- **relay** — 외부 LLM 중계 서버를 읽기 전용으로 본다(비밀 없음). 상태: launchd 프로세스(PID·마지막 종료 코드), 비인증 health(401/200=살아 있음, 연결 거부=죽음, 3초 제한), 공개 입구 감시 로그 마지막 줄, 배포본(`current` 링크 대상 이름), 허용 모델(로그의 마지막 `listening` 이벤트). 사용량: JSON 줄 로그를 **끝 8MB 만** 읽어(회전 없음 대비) 일별 호출·성공률·토큰·평균/p95 시간, 실패 코드별 건수, 최근 실패 10건(메타만). 사용량은 **POST …/complete 줄만** 센다 — health 줄은 `healthChecks`, 그 밖의 요청(접두만 두드림·not_found 탐색·다른 메서드)은 `otherRequests` 로 따로 센다. 순수 로직 `lib/aiRoutes/relay.ts`.
- **설정(env, 비면 중계 구역 숨김)**: `AI_RELAY_LOG_PATH`(JSON 줄 로그) · `AI_RELAY_HEALTH_URL` · `AI_RELAY_LAUNCHD_LABEL` · `AI_RELAY_WATCHDOG_LOG` · `AI_RELAY_DEPLOY_DIR` · `AI_RELAY_LABEL`(사용처 표 이름, 기본 "AI 중계 서버"). 경로의 앞 `~` 는 홈으로 펼친다. 로그·health 둘 다 비면 `configured:false`.
- **AI 비용(추정)**: 집계 각 단위(`totals`·`byDay`·`byFeature`·`byProvider`)에 `usd`(공개 단가 haiku 1/5·sonnet 3/15·opus 5/25 USD per 1M tokens, `lib/llmCost.ts` — 토큰·단가를 아는 행만 합산, 없으면 null)가 붙고, `cost` 는 오늘 토큰(머신 전체, 예산 비교 기준)·오늘/기간 추정 $·예산·초과 여부다. 화면은 teamspace 구역 맨 위 「AI 비용(추정)」 카드(예산 설정 시 진행 바). 예산 가드는 `lib/llmBudget.ts`(30초 메모리 캐시). **정책(결정): 예산 조회가 실패하면 호출을 막지 않고 통과시키며 `llm.budget_check_failed` 경고 로그만 남긴다(fail-open — 가드 장애로 AI 기능이 죽지 않게).**
- UI: 설정 › AI 실행 경로(관리자에게만 보임). CLI(editor 에이전트 토큰 가능): `pnpm ws ai-routes [--days N]` — 한국어 요약(끝에 `비용(추정) 오늘 $x · 기간 $y · 예산 N/M` 1줄).

## 운영 상태 (관리자 — health·백업·디스크·AI 비용)
- `GET /api/ops/status`(**admin**, `Cache-Control: no-store`) → `{ status:{ checkedAt, health:{db,worker,workerAgeSec}, backup:{dir,latest,ageHours,sizeBytes,inProgress?,clockSkew?}, disk:{path,requestedPath,freeBytes,totalBytes,freeRatio}|null, llm:{todayTokens,todayUsd,budgetTokens,exceeded}, build:{version,buildId} }, warnings:[{level:"warn"|"crit",code,message}] }`. 백업은 `${TEAMSPACE_BACKUP_DIR ?? ~/Backups/teamspace}/<YYYYMMDD-HHMMSS>/` 중 최신(폴더명 로컬 시각으로 나이 계산), 디스크는 데이터 디렉토리(`TEAMSPACE_DATA_DIR ?? <repo>/data`)의 statfs — 폴더가 아직 없으면 가장 가까운 상위 폴더로 재고, `path` 는 실제로 잰 경로·`requestedPath` 는 데이터 디렉토리(다르면 CLI 가 표시). 백업 폴더에 `teamspace.dump` 가 없거나 파일이 2분 안에 바뀌었으면 만드는 중이라 건너뛰고 직전 완성본을 보고하며 `inProgress:true`(직전본이 없으면 latest null), 폴더명 시각이 미래면 `clockSkew:true`(나이는 0, 경고 `backup_clock_skew`). 읽기 전용이라 `getTeamspaceUsage(..., { purge:false })` 로 LlmCall 정리를 하지 않는다(주간 지표 수집도 동일, `/api/ai-routes` 는 기본대로 정리). 경고 임계: 백업 30h 초과 warn·72h 초과/없음 crit, 디스크 여유 15% 미만 warn·7% 미만 crit, 예산 초과 warn, 워커 하트비트 90초 초과 warn, DB 다운 crit. 경로가 드러나므로 무인증 `/api/health` 와 달리 관리자 전용.
- UI: 설정 › 운영 상태(관리자에게만). CLI: `pnpm ws ops status`.

## 지표 (주간 스냅샷 — 피드백 루프 ①)
- 워커가 워크스페이스마다 ISO 주(`2026-W41`, UTC 기준)당 1행 `MetricSnapshot` 을 남긴다(기존 정리 블록과 같은 시간당 가드, 이번 주 행이 있으면 건너뜀, 실패는 `metrics.snapshot_failed` 경고). 재는 것: 문서 수·`/api/pages` 응답 select 의 JSON 길이(`docs`·`docsBytes`), 태스크 열림/완료(`tasksOpen`·`tasksDone` — 상태 속성이 있는 보드만, `/api/tasks` 와 같은 상태 규칙), 그래프 노드 근사·저장된 연결 수(`graphNodes`·`graphEdges`), 최근 7일 LLM 호출·캐시 적중·토큰·추정 $(`llm.*`), 최근 7일 레슨 주입 횟수·글자 수(`injection.*`), 응답 캐시 행 수(`llmCacheRows`, 머신 단위). **스냅샷 시점**: 문서·태스크·그래프 수는 그 주 첫 tick(생성 시점) 값이고, `llm.*`·`injection.*` 는 생성 시점 **직전 7일** 합계다(달력 주가 아님). 주 키는 ISO 주 · **UTC** 기준이라 KST 월요일 오전 9시 전 생성분은 전 주 키를 받는다. 화면은 없고 API/CLI 로 본다.
- `GET /api/metrics?weeks=8`(**editor 이상**, 1..52; 비용 `llm.usd` 는 admin 응답에만 — 비관리자는 각 주 `data.llm.usd` 와 diff 의 `llm.usd` 행이 아예 빠짐) → `{ weeks:[{weekKey,data,createdAt}] (최신 먼저), diff:[{key,prev,cur,delta}] }` — diff 는 최근 2주(평탄화 키 `llm.calls` 등, 지난주가 없으면 prev·delta null; `llm.usd` 를 모르면(가격표 밖 모델) cur 도 0 이 아니라 null, CLI 는 `—`). `POST /api/metrics`(**admin**) → 이번 주 스냅샷 즉시 1회 생성 `{ created, weekKey }`(이미 있으면 created:false).
- CLI: `pnpm ws metrics [--weeks 8]`(표: 키·지난주·이번주·Δ) · `pnpm ws metrics snapshot`(admin).

## 주간 다이제스트 (프로젝트별 Slack 요약 — F6)
- 기간 두 가지: **주 단위**(`week` — `Asia/Seoul` 기준 지난주 월 00:00 ~ 이번 주 월 00:00, `weekRange(now, tz)`, 라벨 `MM/DD ~ MM/DD` 끝은 일요일 — 워커가 이것) · **롤링**(`days` 1..31, 기본 7 — 지금부터 거꾸로 n일). 날짜·요일은 서버 TZ 가 아니라 `DIGEST_TZ="Asia/Seoul"` 로 잰다.
- 담는 것: 완료한 태스크(그 프로젝트 보드 행 중 `updatedAt` 이 기간 안이고 지금 상태가 닫힘 — `lib/taskFilter` 규칙 완료·취소 등), accepted 결정(`decidedAt`), 레슨(`createdAt`), 문서(kind=doc·삭제/보관 아님 — 기간 안 생성=새 문서, 그 전 생성+기간 안 수정=수정, 제목 5개), 승인(기간 안 `respondedAt` 의 approved/rejected 수 + 현재 pending 수). Activity 피드는 projectId·상태 전이가 없어 출처로 쓰지 않는다. 순수 로직 `lib/digest.ts`.
- **집계 한계(과대 집계 쪽)**: ① `tasksDone` 은 "기간 안에 닫힌 행" 이 아니라 "기간 안에 바뀐 행 중 지금 닫힌 행" — 상태 전이 이력 테이블이 없어, 지난주 이전에 닫혀 이번 주에 메모만 고친 행도 잡힌다. ② 문서 "수정" 은 `Page.updatedAt` 기준인데 이 값은 이동·정렬(parentId·position 변경)에도 오르므로 트리에서 옮기기만 한 문서도 센다.
- **Slack mrkdwn 안전 처리**: 사용자 문자열(프로젝트·태스크·보드·결정·레슨·문서 제목)은 `& < >` → 엔티티, 서식 기호 `` * _ ~ ` `` → 전각 `＊ ＿ ～ ｀`(제로폭 공백은 안 씀 — 보이지 않아 복사·검색을 망친다), 줄바꿈 → 공백(`escMrkdwn`). 2,500자 상한은 구역당 항목 수를 10→5→3→1→0 으로 줄여 맞추고, 그래도 넘으면 `truncateMrkdwn` 이 엔티티(`&amp;` 등)·서로게이트 쌍 가운데를 피해 자르고 `…` 를 붙인다.
- `GET /api/digest?project=<id>&days=7` | `&week=1`(**editor 이상**, week 는 `1`/`true` 만 — 그 외 400, 있으면 days 무시) → `{ digest:{ project:{id,name}, range:{since,until}, tasksDone:[{title,boardTitle}], decisions:[{title}], lessons:[{title}], docs:{created,updated,titles}, approvals:{approved,rejected,pending} }, markdown }` — 보드·문서는 요청자가 볼 수 있는 것만(D3)이고 보관된 조상 아래(F2)는 제외, 볼 수 없는/없는 프로젝트 404, project 누락·days 범위 밖 400. markdown 은 한국어 + 활동 구성 mermaid pie.
- `POST /api/digest { projectId, days? | week?: true, send: true }`(**admin**) → `{ sent:true, channels }` | `{ sent:false, reason:"empty" }`(활동 0건 — 대기 승인만 있으면 0건) | `{ sent:false, channels, error }`(Slack 미연결 `not_connected`·보낼 채널 없음 `no_channel`·Slack 오류 — 규칙 채널 여럿 중 일부만 실패해도 sent:false, channels=성공 수). **`fireNotif(ws, "weekly_digest", text, projectId, {kind:"digest", fallbackToDefault:true})`** 로 보낸다: 그 프로젝트 `weekly_digest` 규칙 채널 → 없으면 전역 규칙 → 규칙이 하나도 없으면 Slack 기본 채널(종전 동작). 채널은 누가 읽을지 모르므로 잠긴(restricted) 프로젝트 409, 잠긴 보드·문서(조상 포함)와 보관된 조상 아래 보드·문서는 제목도 빼고 보낸다. NotifLog `kind:"digest"` 로 기록.
- **워커**: **Asia/Seoul 월요일 09:00–09:59** 에 한 번(서버 TZ 무관) — Slack 이 연결되고 기본 채널 또는 `weekly_digest` 채널 규칙이 있는 워크스페이스마다, 보관(`archivedAt`)·잠금 아닌 프로젝트 중 **지난주(월~일, `weekRange`)** 활동 1건 이상인 곳에 다이제스트 발송(채널 선택은 위 POST 와 같음 — 보낼 곳이 없는 프로젝트는 skipped, 마커 없음). 중복 방지: NotifLog `kind:"digest_marker"`, `text:"digest:<projectId>:<ISO주>"`(Asia/Seoul 날짜 기준 발송한 주) — 발송 실패여도 마커를 남겨 매분 재시도를 막는다(실패는 `state:failed` 행으로 보임). 마커 조회는 최근 8일로 좁힌다. 워크스페이스·프로젝트 단위로 격리 — 하나가 throw 해도 다음으로 넘어가며 `failed` 로 센다. 로그 이벤트 `worker.weekly_digest` / `worker.weekly_digest_failed` / `digest.workspace_failed` / `digest.project_failed` / `digest.marker_write_failed`(마커 쓰기 실패는 로그만, 워커 메모리 Set 이 같은 프로세스 재발송을 막는다).
- CLI: `pnpm ws digest weekly [--project <id|이름>] [--days 7 | --week] [--dry-run]`(기본 = 마크다운 미리보기, `--project` 없으면 cwd→라우트 규칙, `--days` 롤링·`--week` 지난주 월~일) · `pnpm ws digest weekly --project <id> --send [--week]`(admin, 아니면 403 메시지 + exit 1). **`sent:false`(Slack 오류·채널 없음) 면 오류를 stderr 에 찍고 exit 1** — 활동 0건(`reason:"empty"`)은 실패가 아니라 exit 0.

## 스킬 레지스트리 (관리자 — SKILL.md 사본·낡은 사본)
- 같은 스킬이 레포 메인·워크트리·전역(`~/.claude/skills`)·플러그인(`~/.claude/plugins`)에 흩어진 사본을 서버가 디스크에서 훑어 묶는다. **보고만** 한다(사본을 고치지 않음 — 갱신은 사람이 cp 또는 워크트리 리베이스). DB 저장 없음, 결과는 머신 단위 5분 캐시(한도에 걸려 잘린 결과는 30초, 잘렸는데 0개면 캐시 안 함).
- **설정(env, 비면 `{configured:false}` — 기능 숨김)**: `SKILL_SCAN_ROOTS`(콜론 구분, 앞 `~` 펼침, 예 `~/dev:~/.claude`) · `SKILL_SCAN_MAX_DEPTH`(루트 아래 폴더 깊이, 기본 7, 1~12) · `SKILL_SCAN_TIME_BUDGET_MS`(시간 한도, 기본 15000, 500~120000). 건너뜀: `node_modules`·`.git`·`.next`·`dist`·`build`·`coverage`·`.turbo`·`.cache`·`.pnpm-store`·`Library`·`ios`·`android`·`Pods`·`.venv`·`venv`·`__pycache__`·`target`·`out`·`tmp`·`app/generated`(단 `skills/` 바로 아래 스킬 폴더는 이름과 무관하게 봄), 심볼릭 링크(따라가지 않음). **레포 체크아웃(`.git` 있는 폴더)에서는 `.claude`·`.agents` 만 내려간다**(워크트리 `.claude/worktrees/<이름>` 도 같은 규칙; 루트에 `.claude-plugin` 이 있는 플러그인 원본 레포와 `~/.claude/plugins` 안은 예외로 통째로), `~/.claude` 바로 아래 세션 기록·캐시 폴더(`projects`·`file-history`·`shell-snapshots`·`todos` 등)도 건너뜀. 한도: 사본 5000개·폴더 20만 개·시간 한도 — 닿으면 `scan.truncated`/`truncatedReason`.
- 사본: `id`(절대 경로 sha1 앞 12자리) · `name`(앞머리 `name:`, 없으면 폴더 이름) · `description`(첫 줄) · `sha256` · `lines` · `mtime` · `kind`(repo=`.git` 폴더인 메인 체크아웃 / worktree=`.git` 파일→`<메인>/.git/worktrees/<이름>` / global / plugin / other — 전역·플러그인 경로가 git 판정보다 먼저) · `repo`(메인 레포 폴더 이름) · `branch`(HEAD 파일, 셸 안 씀) · `path`·`checkout`(홈은 `~` 로 줄여 보냄).
- 묶음 키 = 이름 + 범위(`repo:<레포>` · `global` · `plugin:<마켓>/<플러그인>[/<변형>]` — 설치 버전 폴더·`plugins`/`external_plugins` 접두·끝 `skills` 를 빼서 버전끼리·마켓 원본과 묶고, discord/telegram 처럼 다른 플러그인은 가름 · `other`) — 레포가 다르면 같은 이름도 다른 스킬. **기준본** = 메인 체크아웃 사본(여럿이면 `.claude/skills` 아래 것 → 최근 것), 없으면 가장 최근 사본. 상태 `canonical | same | differs_newer(다르고 더 새것) | stale(다르고 더 오래됨 = 낡은 사본)`. 시각은 파일 mtime 이라 워크트리 사본은 체크아웃 시각이 찍힌다 — 메인 체크아웃 쪽이 뒤처져 있으면 워크트리 사본이 `differs_newer` 로 나온다(그땐 메인 체크아웃을 당겨야 한다는 뜻).
- `GET /api/skills/registry[?refresh=1][&stale=1][&name=<부분일치>]`(**admin**, `no-store`) → `{ configured:true, scannedAt, scan:{truncated,truncatedReason,dirsVisited,errors,durationMs,maxDepth,roots:[{path,exists}]}, summary:{groups,copies,staleCopies,groupsWithStale,differingCopies,distinctContents}, groups:[{key,name,scope,canonicalId,distinct,stale,differs,copies:[…,status]}], filtered }`. 정렬: 낡은 사본 많은 묶음 → 다른 사본 있는 묶음 → 이름. `stale`·`name` 은 묶음 필터일 뿐 summary 는 전체 기준.
- `GET /api/skills/registry/diff?a=<id>&b=<id>`(**admin**) → `{ configured:true, a, b, diff:{lines,added,removed,truncated,identical} }` — 줄 단위 unified diff(문맥 3줄, 400줄에서 자름). **최근 스캔에 있는 id 만** 받는다(임의 경로 읽기 없음, 없으면 404, 파일이 사라졌으면 410).
- UI: 설정 › 스킬 레지스트리(관리자) — 요약·낡은 것만/다른 사본 있음/이름 검색·묶음 펼치기·"기준본과 비교". CLI: `pnpm ws skills [--stale] [--name <스킬>] [--refresh]`(다른 사본이 있는 묶음만, `--name` 이면 전부), `pnpm ws skills diff <a id> <b id>`. 순수 로직 `lib/skills/scan.ts`(스캔·분류)·`lib/skills/registry.ts`(묶기·diff·캐시).

## 협업 (W6): 인박스 · 활동 피드 · 코멘트 · 업로드

- **알림 인박스**: `GET /api/notifications[?unread=1&type=approval,assigned,mention,due,proposal,shared]` → `{notifications, unread, byType}` (`unread`·`byType`(종류별 미읽음)은 type 필터와 무관한 전체 미읽음). **type 은 생산자가 실제로 쓰는 6종뿐** — 문서 코멘트 알림은 `comment` 가 아니라 `mention` 으로 쌓이고, 모르는 값이 섞이면 400(조용히 버려 전체 목록을 내보내지 않는다) · `PATCH /api/notifications/<id> {read}` · `POST /api/notifications {readAll:true}` 또는 `{ids:[…]}`(묶음 읽음, 본인 것만, 최대 500). **묶어 보기**: `GET /api/notifications?group=1` → `{groups, unread, byType}`(groups=`{key(type|link),type,link,count,unread,latestAt,ids,sample≤3}`, 같은 type+link 를 최신 항목 기준 24h 창으로 묶음, `limit` 은 묶기 전 원본에 적용) · **다이제스트** `GET /api/notifications/digest?hours=24` → `{since,until,total,unread,byType,topGroups≤5}`(본인 알림, viewer 허용. total·unread·byType 은 DB count/groupBy 정확값, topGroups 만 최신 1000건에서 묶음). 적재 시점: 태스크 배정(`assigned`, 담당자 이름→멤버 매칭)·@멘션(`mention`, 문서 코멘트 포함)·승인 요청(`approval`, admin들, link `/approvals?id=<approvalId>`)·마감(`due`)·지식 승격 제안/결과(`proposal`)·문서·프로젝트 공유(`shared`). **승인 요청 알림은 결정(앱 PATCH·슬랙 버튼/모달) 시 자동 읽음**(`recordDecision`), 14일 지난 미읽음 승인 알림은 GET 시 워크스페이스별 하루 1회 자동 읽음(`lib/notificationsCleanup.ts`). UI `/inbox`(종류 칩·사이드바 미읽음 배지), CLI `inbox ls [--unread] [--group] [--type approval,mention]`/`inbox digest [--hours n]`/`inbox read [id]`, MCP `inbox_list {unread?, group?, type?}`(type=쉼표 구분).
- **활동 피드(경량 감사로그)**: 문서·태스크·결정·승인·업로드 행위가 Activity 로 기록. `GET /api/activity?limit=&type=&actor=`, CLI `activity ls`, 대시보드 "최근 활동" 패널(에이전트 실명 표시).
- **문서 코멘트**: `GET/POST/DELETE(?commentId=) /api/pages/<id>/comments {body}` · **인라인 코멘트(격차 D2)**: POST 에 `anchor:{quote,prefix,suffix}` 를 실으면 그 문구에 달린다. **글자 오프셋을 저장하지 않는다** — 문서가 편집되면 전부 어긋나므로 인용문+앞뒤 문맥을 저장하고 조회할 때마다 현재 본문에서 다시 찾는다(`lib/anchor.ts`). GET 응답에 `inline`·`range`·`orphan` 이 붙고, **못 찾으면 엉뚱한 곳에 붙이지 않고 `orphan:true`**(억지로 붙이면 맞는 것처럼 보여서 더 나쁘다). 해결은 `PATCH .../comments?commentId= {resolved}` — 지우지 않고 접는다. UI: 문서 리더에서 문구를 드래그 선택하면 그 문장에 달린다. CLI: `doc comment <id> --body "…" --quote "<본문 문구>"`, `doc comment resolve <id> <commentId> [--undo]`. — 본문 `@이름` 은 멤버 매칭되어 인앱 알림 + comment_added 규칙 발화. 문서 리더 하단 코멘트 섹션, CLI `doc comment <pageId> --body`.
- **파일 업로드**: `POST /api/upload` (multipart `file`, 20MB) → `{url, markdown}` — public/uploads/<ws>/ 로컬 저장, 반환 마크다운을 문서에 붙여 사용.
- **자동 갱신**: 보드·문서 목록·대시보드·인박스는 30초 폴링+창 포커스 시 refetch(`lib/useAutoRefresh`). 푸시(SSE)는 W8.
- **프레즌스(격차 D4)**: `POST /api/presence {pageId, editing?}`(하트비트 15초) · `GET /api/presence?pageId=` → `{viewers:[{userId,name,editing}]}`(자기 자신 제외, TTL 30초). **DB 에 쓰지 않는다** — 웹 프로세스 메모리에 두고 TTL·상한으로 정리한다(하트비트를 영구 저장할 이유가 없고 재시작되면 다시 모인다). *전제: 웹 인스턴스가 하나다(맥미니 launchd). 여러 개로 늘리면 공유 저장소로 옮겨야 한다.* 숨은 탭은 하트비트를 쉬고(배경 탭까지 '보는 중'이면 거짓말), 탭으로 돌아오면 즉시 갱신한다. 못 보는 페이지에는 존재를 알릴 수 없다(D3 연동). UI: 문서·보드 상단 아바타 + "N 편집 중". CLI: `pnpm ws presence <pageId>`.
- **의존관계(최소)**: `pnpm ws task block <rowId> --by <선행rowId>` — "선행 태스크"(relation) 속성을 자동 생성해 rowId 배열로 기록(컨벤션).

## 승인 / 리마인더 / 슬랙 / 세션

- 승인: `POST /api/approvals` `{ title, body, kind?(general/status/triage/doc/project/deploy), highRisk?, channel?, projectId? }` → 발송 시 디자인시스템 카드(액센트 바·kind/위험 배지·요청자/프로젝트/시각 메타)로 전송, 결정 시 결과 카드로 치환. CLI: `pnpm ws approval add <title> --body <b> [--kind <k>] [--high] [--channel <id>] [--project <projectId>]`. `PATCH /api/approvals/<id>` `{ status(approved/rejected/additional), responseText? }` — **이미 결정된 승인은 409**(앱·슬랙 공통, W8), 결정자(respondedBy) 기록. **고위험(highRisk) 승인은 에이전트 토큰으로 결정하면 403** — 사람(로그인 세션 또는 슬랙 버튼)만 결정한다(자기 승인 차단, env 금고 P1). 그래서 `approval resolve` 는 고위험 건에 쓰지 못한다.
- 리마인더: `POST /api/schedules` `{ remindAt(ISO/datetime-local), text, channelId?, databasePageId? }` · `DELETE /api/schedules/<id>`. 채널 우선순위: 명시 channelId > 기본 채널 — 기본 채널은 `PATCH /api/slack {defaultChannelId}` 로 저장(env 토큰 모드도 지원, .env 수정 불필요) 또는 `AUTH_SLACK_DEFAULT_CHANNEL` env. 전부 없으면 failed. **워커(launchd `com.teamspace.worker`)가 상시 디스패치 중**(60초 폴링). **반복 리마인더(W7)**: `{repeat:"daily"|"weekly:MON", time:"HH:MM"}` → kind=cron, 발송 후에도 active 유지. CLI: `remind add --every daily --time 09:00`.
- 예약 디스패치(워커): `POST /api/cron/tick` → 만기 `once` 스케줄을 스캔해 Slack 발송 후 `done/failed` 마킹 → `{ checked, sent, failed, ids }`. `GET /api/cron/tick` → `{ active, due }`(부수효과 없음). `pnpm ws tick`(`--preview`=GET). 상시 처리는 **워커 컨테이너** `pnpm worker`(DB 폴링, `WORKER_INTERVAL_MS` 기본 60초; `docker compose --profile worker up -d --build worker`). 로직은 `lib/dispatch.ts`(`selectDueOnce` 순수함수 + `dispatchDue`), 외부 cron 은 `x-ws-token` 으로 `/api/cron/tick` POST. (BullMQ+redis 대신 DB 폴링 — redis 는 compose 에 있고 분산 재시도 필요 시 후속 업그레이드.)
- 슬랙: `GET/PATCH/DELETE /api/slack`, `POST /api/slack/connect {token}`, `POST /api/slack/test`. 토큰은 `AUTH_SLACK_BOT_TOKEN` env 우선, 없으면 DB. 슬랙 인터랙션 콜백: `POST /api/slack/interactions`.
- 발송 내역: `GET /api/slack/log?kind=&limit=` → `{ logs[], total, failed, sentToday }`. `postMessage`/`sendApproval` 발송 시 `NotifLog`에 자동 기록(kind: manual/approval/reminder/test/notification). 슬랙 화면 '알림 발송 내역' 섹션·대시보드 '오늘 보낸 알림'에서 사용.
- 채널 목록: `GET /api/slack/channels` → `{ ok, channels:[{id,name}], error? }`(공개 채널, `channels:read` 스코프 필요). 슬랙 화면 채널 입력의 피커(datalist)·`pnpm ws slack channels`.
- 자동 알림 규칙: `GET/POST /api/notif-rules` `{ event(task_created/task_status/task_assigned/task_due/comment_added/doc_saved/weekly_digest), targetId(채널), projectId?(프로젝트 스코프, 없으면 전역) }` · `PATCH /api/notif-rules/<id> {enabled}` · `DELETE`. **7개 이벤트 전부 실발화**(`weekly_digest` = 주간 다이제스트, 규칙이 없으면 기본 채널로 폴백하는 유일한 이벤트 — 위 "주간 다이제스트" 절): 생성(rows POST)·상태 변경(rows PATCH)·담당자 변경(PATCH·claim)·마감(워커 일일 스캔, `due_marker`로 하루 1회 중복 방지)·댓글(pages/[id]/comments POST)·문서 저장(pages/[id] PUT). 뒤 둘은 발화 코드가 있었는데 규칙 생성 화이트리스트에서 빠져 있어 무동작이었다(2026-08-07 수정). dm 타깃은 미지원(400). **매칭 우선순위: 프로젝트 규칙 우선, 없으면 전역**. CLI: `pnpm ws notif-rule add <event> <channel> [--project <projectId>]`. 슬랙 화면 '자동 알림 규칙' 섹션.
- 세션(M4): `POST /api/ingest`(HMAC 또는 **에이전트 토큰**) → `GET /api/sessions`(최근 100건 `{id, externalId, project, cwd, status, startedAt, endedAt, lastSeenAt, _count.items}`), `/api/sessions/<id>`. items 의 `externalRef` 는 중복 적재 스킵(멱등). **active 세션이 24h 무동기면 워커가 ended 처리**(W8). 세션 종료 훅이 팀 프로젝트 cwd 에 한해 요약 메타(첫 프롬프트 1줄·관찰 수)만 적재 — 관찰 원문은 로컬(agentmemory)에만.
- **라이브 세션 보드(Console 4)**: SessionStart 훅이 인입 본문에 `branch`·`repo`(본체 레포 폴더 이름 — 워크트리여도 본체 기준)·`worktree`(연결된 워크트리일 때만 경로)를 싣고(`git rev-parse` 1초 제한, 실패 시 생략), 토큰 인입이면 `agentName`=토큰 이름·`lastSeenAt` 을 남긴다. PostToolUse 훅(`teamspace-project-context.mjs`)이 세션당 10분에 1번 `POST /api/sessions/heartbeat {sessionId, cwd?, branch?, repo?, worktree?}`(editor+, 1초 제한, 상태 파일 `$TMPDIR/teamspace-heartbeat-<세션>.json`)로 `lastSeenAt`·`lastSyncedAt` 을 갱신한다 — 행이 없으면 만들고 ended 세션은 되살린다(resume). `GET /api/sessions/live`(editor+) → `{ windowHours:2, sessions:[{externalId, repo, branch, worktree(짧은 이름), worktreePath, cwd, agentName, startedAt, lastSeenAt, tasks:[{id,title,board,boardTitle}]}], locks:[…] }` — 살아 있음 = active 이고 마지막 활동(없으면 시작)이 2시간 안, tasks = 그 에이전트 이름이 담당인 **'진행 중'** 태스크(볼 수 있는 보드만). CLI: `sessions live` · `session heartbeat [<id>]`. UI: 설정 › 라이브 세션·잠금(30초 새로 고침).
- **공유 브랜치 푸시·배포 잠금(Console 4, 결정 A — 예약 + pre-push 경고, 푸시는 절대 막지 않음)**: 손으로 메시지 주고받던 develop/main 푸시 조율(레슨 cmuwqvc1a)을 대신한다. 이름은 자유 형식 자원 키 `^[a-z0-9][a-z0-9:/._-]{0,80}$` (예: `banjang/develop`·`teamspace/main`·`deploy:teamspace`), URL 에는 `encodeURIComponent` 로 한 세그먼트에 담는다. 이름당 한 행, 만료·해제면 빈 잠금.
  - `POST /api/locks/<name> {ttlMinutes?(기본 30, 1~240), note?, session?, cwd?, branch?}` → `{result: taken|refreshed, lock}`. 같은 보유자면 연장(takenAt·메모 유지), 남이 잡고 있으면 **409 `{conflict, lock:{holderName,note,ageMin,remainingMin,…}}`**. 보유자 = 토큰 이름(+토큰 User) — 세션 id 가 양쪽에 있으면 세션까지 같아야 같은 보유자(같은 토큰의 다른 세션도 남), 한쪽이 없으면 이름으로만. 잡기는 조건부 updateMany(내 것 → 빈 것) + unique create 라 동시 호출에도 한쪽만 이긴다.
  - `PATCH /api/locks/<name> {ttlMinutes?, session?}` 연장(보유자만, 빈 잠금 404·남의 것 409) · `DELETE /api/locks/<name>[?session=&force=1]` 해제(보유자만 — 남은 403, **force 는 관리자 로그인 세션만**, 관리자 토큰도 403, 강제 해제 시 보유자 인박스 알림) · `GET /api/locks/<name>[?session=]` → `{lock|null}`(`lock.mine`) · `GET /api/locks` → `{locks}`(살아 있는 것만).
  - `POST /api/locks/<name>/notify {session?, branch?, cwd?}` → 남의 살아 있는 잠금이면 보유자(토큰의 시스템 User) 인박스 알림(`type:"lock"`) + 활동 `push_warned`, **잠금당 5분 1회**(`{notified, reason: sent|throttled|mine|free}`). 활동 피드: `locked`·`released`·`force_released`·`push_warned`(연장은 안 남김). 세션 id 를 보내면 그 세션 `lastSeenAt` 도 갱신.
  - CLI: `lock take <name> [--ttl 30m|2h|1h30m] [--note "…"] [--cwd <path>]`(남의 것이면 보유자·메모·나이·만료와 함께 exit 1) · `lock extend <name> [--ttl]` · `lock release <name>` · `lock ls` · `lock notify <name>`. 세션 id 는 env `CLAUDE_SESSION_ID`/`CLAUDE_CODE_SESSION_ID`, cwd 는 `--cwd` > `INIT_CWD`(pnpm 이 원래 폴더를 넘긴다).
  - **pre-push 경고 훅**(git 훅, Claude 훅 아님) `scripts/hooks/git-pre-push.mjs`: stdin 의 브랜치 푸시를 `<repo>/<branch>`(소문자) 잠금으로 바꿔 `GET /api/locks/<name>?session=` → 남의 것이면 stderr 경고 + notify, **항상 exit 0**, 서버가 안 닿으면 전체 1.5초 안에 통과(fail open). 설치: `pnpm ws lock install-hook [--repo <path>]` → `<git-common-dir>/hooks/teamspace-pre-push.mjs`(사본) + `pre-push` 래퍼(기존 pre-push 는 `pre-push.teamspace-chained` 로 옮겨 같은 stdin 으로 이어 부르고 그 종료 코드가 최종 결과, 재실행은 갱신만). `core.hooksPath` 레포는 덮어쓰지 않고 수동 연결 방법을 안내하며 거부. 워크트리에서 설치해도 본체 hooks 에 들어간다.
  - 쓰는 법: 공유 브랜치에 푸시·배포하기 전 `lock take banjang/develop --note "CI 대기"` → CI·배포 끝나면 `lock release`. 길어지면 `lock extend`.
- 슬랙 컨펌 발송/수신 스크립트: `scripts/slack-confirm.ts` — **approvals API 래퍼**(버튼 카드 발송, 기본 채널 `#workspace-confirm` C000WORKSPACE). `--wait` 로 status 폴링(exit: approved=0/additional=2/rejected=3/timeout=124), `--check <approvalId>` 로 상태 조회. 인증은 `pnpm ws` 와 같은 토큰 체인.

## 환경변수 검증 (기동 시)

기동 시 `lib/env.ts`(`validateEnv`, 순수 함수)가 진입점별로 env 를 검증한다 — web 은 `instrumentation.ts`, 워커는 `scripts/worker.ts`. production 에서 `DATABASE_URL`·`AUTH_SECRET`(16자 이상, web) 이 없으면 기동 실패(web 은 throw, 워커는 exit 1)하고, dev 에서는 `AUTH_SECRET` 이 경고다. 접두·형식 위반(`ANTHROPIC_API_KEY`·`PUBLIC_BASE_URL`·`LLM_*` 등)은 경고, `ASK_LLM_PROVIDER`·`LLM_DAILY_BUDGET_TOKENS` 위반은 오류다. `ENV_VAULT_KEY` 는 `lib/envVault` 소유라 검사하지 않는다.

## 서버 로그 (구조화 로그·요청 id)

서버 로그는 `lib/log.ts` 하나로 낸다(의존성 0, 노드·엣지 공용). `log.info|warn|error("도메인.사건", { msg: "한국어 설명", ...필드 })` — 이벤트 이름은 소문자 스네이크(`slack.call_failed`, `env.invalid`, `llm.budget_exceeded`, `worker.tick_failed`), `Error` 는 `{name,message,stack(앞 5줄)}` 로 직렬화. warn/error 는 stderr, 나머지는 stdout. 요청 객체가 있는 라우트는 `withReq(req)` 로 모든 줄에 `reqId` 를 섞는다.

| env | 값 | 기본 |
|---|---|---|
| `LOG_FORMAT` | `json`(한 줄 JSON `{"t","level","event","reqId",…}`) \| `pretty`(`12:34:56 WARN event reqId=… k=v`) | production 은 json, 그 외 pretty |

- **모든 API 응답에 `x-request-id` 헤더가 붙는다**(미들웨어가 매기고 라우트 요청 헤더로도 넘긴다 — 401·429·로그인 리다이렉트 포함). 앞단이 보낸 `x-request-id` 가 `[A-Za-z0-9._:-]{1,128}` 이면 이어받고, 아니면 새 uuid. 예외: 미들웨어 matcher 에서 빠진 `/api/import`·`/api/sites`(대용량 업로드)와 정적 자산에는 헤더가 없다. 문제를 보고할 때 이 값을 같이 주면 서버 로그에서 그 요청 줄을 찾을 수 있다.

## env 금고 (프로젝트·환경별 env 값, P1·P2·P3)

프로젝트·환경(local|dev|prod|자유 문자열)별 env **값**을 AES-256-GCM 암호문으로 보관한다. 마스터 키 `ENV_VAULT_KEY`(base64 32바이트, `openssl rand -base64 32`)가 없거나 형식이 틀리면 모든 `/api/env/**` 가 **503 "env 금고가 꺼져 있습니다(ENV_VAULT_KEY)"**. 키 분실 = 복구 불가(백업은 사용자 책임).

**절대 규칙: 값은 stdout·로그·에러·보드·문서·채팅 어디에도 쓰지 않는다.** CLI 도 키 이름·개수만 출력한다. pull 로 쓴 파일을 직접 읽어 보여주지 말 것.

| 라우트 | 권한 | 비고 |
|---|---|---|
| `GET /api/env?projectId=&env=` | viewer+ | `{vars:[{id,env,key,version,valueLength,note,syncGroup,updatedByName,updatedAt,sync:{<targetId>: match\|differs\|never},drift:{<targetId>: <드리프트 상태>}}], envs, targets}` — 값·지문 없음. `sync` 는 같은 env 의 대상마다 금고 현재 값 지문 vs 마지막 반영 지문, `drift` 는 그 대상의 마지막 드리프트 점검에서 이 키의 상태(점검 기록이 있을 때만, projectId 를 줄 때만) |
| `PATCH /api/env/vars/<id> {note?,syncGroup?}` | **admin 로그인 세션만** | 값은 그대로 두고 메모·syncGroup 만 교체(빈 문자열·null = 해제). 감사 `meta` |
| `GET /api/env/sync-groups` | viewer+ | 워크스페이스 전체 `{syncGroups:[{name, members:[{projectId,projectName,env,key,varId}], consistent}]}` — 서버가 금고 값 HMAC 지문으로 비교(응답에 값·지문 없음) |
| `PUT /api/env/vars {projectId,env,key,value,note?,syncGroup?}` | **admin 로그인 세션만**(에이전트 토큰 403) | 덮어쓰면 version+1·직전 암호문 이력 |
| `DELETE /api/env/vars/<id>` | admin 로그인 세션만 | 이력도 삭제 |
| `POST /api/env/reveal {ids}` | admin 로그인 세션만 | 값 반환·`Cache-Control: no-store`·감사 |
| `POST /api/env/pull {projectId,env,purpose?}` | admin 세션 또는 editor+ 에이전트 | `{vars:[{key,value}]}`·no-store·감사 1행(`purpose`=`pull` 기본→action `pull`, `drift`→action `drift_read`; 그 밖 400) |
| `POST /api/env/import {projectId,env,vars:[{key,value}],mode?(merge\|overwrite),channel?}` | editor+ | **바로 쓰지 않는다** → 봉인된 대기 작업(EnvOp, 30분) + 고위험 승인(kind=deploy) → `{opId, approvalId, sent, diff}` |
| `POST /api/env/import/<opId>/apply` | editor+ | 승인 approved·미만료·미적용일 때만 반영(아니면 409/410) |
| `GET /api/env/targets?projectId=&env=&id=` | viewer+ | push 대상 `{targets:[{id,projectId,env,kind,config,account,summary,accountSummary,lastPushedAt,lastPushedKeys,lastDriftAt,lastDrift:{KEY:상태},driftIssues}]}` — 지문 없음. `driftIssues` = 마지막 점검의 differs+missing_remote+remote_only 수 |
| `POST /api/env/targets {projectId,env,kind,config,account?}` | editor+ 에이전트 · admin 사람 세션 | 201 `{target}`. 같은 곳 중복 409. config·account 는 비밀이 아님 — 토큰처럼 보이는 문자열·모르는 필드는 400 |
| `PATCH /api/env/targets/<id> {config?,account?}` | editor+ 에이전트 · admin 사람 세션 | kind·env 고정. 가리키는 곳이 바뀌면 lastPushed 초기화 |
| `DELETE /api/env/targets/<id>` | editor+ 에이전트 · admin 사람 세션 | 원격 값은 그대로, 대기 중 push 작업은 함께 삭제 |
| `POST /api/env/targets/<id>/push {keys?,channel?}` | editor+ 에이전트 · admin 사람 세션 | **값을 주지 않는다** → push 작업(EnvOp kind=push, 30분, 요청 시점 키별 version 봉인) + 고위험 승인(kind=deploy) → `{opId, approvalId, sent, keys, expiresAt}`. keys 생략 = 그 env 의 모든 키 |
| `POST /api/env/push/<opId>/claim` | admin 세션 또는 editor+ 에이전트, **요청한 그 토큰만**(다르면 403) | 승인 approved·30분 안·처음일 때만 `{targetId, vars:[{key,value}]}`·no-store·감사 `push`. 재호출 409, 승인 전 409, 만료 410, 요청 뒤 값이 바뀌면 409 |
| `POST /api/env/push/<opId>/result {pushed:[key], failed:[{key,error}]}` | claim 한 토큰만 | 키 이름만 쓴다(error 문구 저장 안 함). 지문은 **서버가** claim 때 봉인한 값으로 계산 — 클라이언트 해시는 받지 않음. 상태 done\|partial\|failed, 한 번만(409) |
| `POST /api/env/targets/<id>/drift {results:{KEY: 상태}}` | editor+ 에이전트 · admin 사람 세션 | CLI 가 원격과 비교한 **키 → 상태만** 기록(값·해시 안 받음). 상태: 값 읽는 대상(dotenv·ssm) = `match\|differs\|missing_remote\|remote_only`, 이름만 읽는 대상(vercel·gha) = `present\|missing_remote\|remote_only`. 금고에 있는 키는 remote_only 불가·금고에 없는 키는 remote_only 만(400), 키 1000개 상한. `lastDrift` 통째 교체·`lastDriftAt` 갱신·감사 `drift`. 대상 config 가 다른 곳을 가리키게 바뀌면 점검 기록도 초기화 |
| `GET /api/env/log?projectId=&limit=` | admin | 감사 로그(reveal·set·delete·meta·import_request·import_apply·pull·push_request·push·push_result·target_add·target_update·target_delete·drift·drift_read, 키 이름만, Funnel 경유 표시 — 목록 조회는 남기지 않음) |

- 키 이름 `^[A-Z_][A-Z0-9_]*$`, **빈 값 거부(400 "값을 입력해 주세요.", import 는 빈 값 키 이름을 나열해 400)**, 값 64KB 상한, env 이름 `[A-Za-z0-9_-]{1,32}`. import 한 번에 500개.
- import 모드: `merge`(기본) = 없는 키만 추가 · `overwrite` = 있는 키도 덮어씀. 삭제는 하지 않는다. diff 는 **키 이름 기준**(값 비교 없음).
- **사람 확인 = 승인 클릭**: CLI 는 항상 에이전트 토큰이라 토큰 종류로 사람을 못 가른다. 그래서 CLI 쓰기는 고위험 승인을 거치고, 고위험 승인은 에이전트가 결정할 수 없다(위 승인 절).

CLI (`scripts/wsEnv.ts`):
```bash
pnpm ws env ls <project> [--env dev]                       # 키·버전·길이·syncGroup·대상별 동기/원격 상태 (값 없음) + 이 프로젝트가 걸린 syncGroup 불일치 경고
pnpm ws env groups                                         # 워크스페이스 전체 syncGroup 일관성(일치/⚠ 불일치·멤버 프로젝트/env/키)
pnpm ws env import <project> <env> --from .env.local        # 드라이런: 추가/변경/건너뜀 키 이름
pnpm ws env import <project> <env> --from ssm:/app/dev --profile p --region ap-northeast-2 --overwrite --apply --channel <slackId>
#   --apply → 승인 카드 발송 → 5초 간격 폴링(최대 30분) → approved 면 apply. 거부·추가요청이면 반영 안 함.
#   --channel 생략 시 WS_CONFIRM_CHANNEL env, 그것도 없으면 서버 기본 채널.
#   ssm 은 `aws ssm get-parameters-by-path --recursive --with-decryption`(셸 없이 execFile), 키=경로 마지막 조각.
pnpm ws env pull <project> <env> --out .env.local [--force] # 0600 파일로만. 기존 파일이면 키 이름 diff 후 --force 요구
pnpm ws env log [<project>] [--limit 50]                    # 감사 로그(admin 토큰)
```
`<project>` 는 id·이름·short(대소문자 무시). UI: 설정 › **env 금고**(admin 만 값 보기·편집·삭제·감사 로그, 반영 대상 목록·추가·삭제·마지막 드리프트 점검, 키마다 대상별 동기·원격 상태 배지, syncGroup 불일치 경고).

### push 대상(targets)·push (P2)

서버는 클라우드 권한을 갖지 않는다 — 원격 반영은 **CLI 가 로컬 로그인(aws·vercel·gh)으로** 한다. 대상 config·account(기대 계정):

| kind | config | account(기대 계정) |
|---|---|---|
| `dotenv` | `{path}` 절대 경로(/… 또는 ~/…) | 없음 |
| `ssm` | `{prefix:"/app/dev", region?, profile?}` | `{accountId}` 12자리 |
| `vercel` | `{project, target: development\|preview\|production, scope?, globalDir?(-Q 두 계정용)}` | `{user}` (vercel whoami) |
| `gha` | `{repo:"owner/repo", environment?}` | `{login}` (gh 로그인) |

```bash
pnpm ws env target add <project> <env> --kind dotenv --path ~/app/.env.local
pnpm ws env target add <project> <env> --kind ssm --prefix /app/dev --region ap-northeast-2 --profile p --account 123456789012
pnpm ws env target add <project> <env> --kind vercel --vercel-project web --target preview [--scope team] [--global-dir ~/.vercel-x] --account <vercel 사용자>
pnpm ws env target add <project> <env> --kind gha --repo owner/repo [--gh-env prod] --account <gh 로그인>
pnpm ws env target ls <project> [--env dev]                # id·종류·요약·기대 계정·마지막 반영 (+ --env 없으면 세션 주입 미리보기)
pnpm ws env target set <id> --account <기대 계정>          # 기대 계정 교체(설정 변경은 rm 후 add)
pnpm ws env target rm <id>
pnpm ws env push <targetId> [--keys A,B]                   # ① 계정 확인 ② 드라이런: 추가/변경/동일/원격에만 있음(지우지 않음) — 키 이름만
pnpm ws env push <targetId> --apply --wait [--channel <slackId>]   # ③ 승인 카드 → 최대 10분 폴링 → claim → 반영 → 결과 기록
pnpm ws env push <targetId> --apply                        #    --wait 없이: 승인 요청만 만들고 끝 → 승인 뒤 30분 안에:
pnpm ws env push <targetId> --op <opId>                    #    승인된 작업을 이어서 claim·반영
pnpm ws env drift <targetId>                               # 드리프트 점검: 계정 확인 → 원격과 비교 → 키별 상태만 서버 기록
pnpm ws env drift --all [--project <p>] [--env <e>]        #    여러 대상(실패한 대상은 건너뛰고 끝에 비정상 종료)
```
- **계정 확인**(불일치면 승인 요청도 만들지 않고 거부): ssm=`aws sts get-caller-identity`(Account) · vercel=`vercel [-Q dir] whoami --format json [--scope]`(username) · gha=`gh api user --jq .login` — **GITHUB_TOKEN/GH_TOKEN 을 뺀 환경으로** 실행해 본인 로그인을 본다(회사 토큰 함정).
- **드라이런 원격 키 이름**(값은 읽지 않음): dotenv=파일 파싱 · ssm=`get-parameters-by-path --query Parameters[].Name`(복호화 없음, 바로 아래 단계만) · vercel=`env ls <target> --project --format json` · gha=`gh secret list --json name`. 못 읽으면 마지막 반영 지문으로만 판단. 기본 전송 = 추가+변경, `--keys` 를 주면 동일한 것도 다시 보낸다. 원격에만 있는 키는 **지우지 않고 보고만**.
- **값 전달**: dotenv=기존 줄·주석 보존 병합 후 0600(임시 파일+rename) · ssm=`put-parameter --type SecureString --overwrite --value file://<0600 임시 파일>`(직후 삭제) · vercel=`env add KEY <target> --project --force --yes`(값은 **stdin**, 빈 임시 폴더에서) · gha=`gh secret set KEY --repo [--env]`(값은 **stdin**, 토큰 env 제거). 값은 프로세스 인자·stdout 에 절대 없다. 실패 메시지에 값이 섞이면 `***` 로 가린다.
- **운영**: env 이름이 /prod/i 이거나 vercel target=production 이면 TTY 에서 `yes` 입력 필수(비대화형은 거부).
- 권한: 대상 추가·수정·삭제·push 요청은 **editor 이상 에이전트 토큰**(admin 토큰 불필요) 또는 **admin 사람 세션**(editor 사람은 403). 진짜 관문은 **사람의 고위험 승인 클릭** — 에이전트는 고위험 승인을 결정할 수 없고(403), 값은 승인 뒤 요청한 그 토큰에게만 한 번 나간다.
- **드리프트 점검(P3a)**: 서버는 클라우드 권한도 원격 값도 받지 않는다 — 비교는 CLI 메모리에서만. dotenv=파일 파싱 · ssm=`get-parameters-by-path --with-decryption --output json`(바로 아래 단계만, stdout JSON 을 메모리에서 파싱) 은 **값 비교**: 금고 값은 `POST /api/env/pull {purpose:"drift"}` 로 메모리에만 받는다(감사 `drift_read` 1행 — 값 반출은 그대로 남되 `pull` 로 섞이지 않음). vercel(`env ls`)·gha(`gh secret list`, GITHUB_TOKEN/GH_TOKEN 제거)는 **이름만** → `present/missing_remote/remote_only` + P2 신호("마지막 반영 이후 금고 값이 바뀜" = sync differs) 를 출력. 출력은 상태별 키 이름·개수만(한국어). 화면: 대상마다 "마지막 점검 · 다름 N"·원격에만 키, 키마다 원격 상태 배지.
- **syncGroup(P3b)**: 같은 syncGroup 이름의 키(프로젝트·env 무관)는 값이 같아야 한다. 웹 키 편집 폼에서 지정·해제(값 칸을 비우면 값은 그대로 두고 syncGroup·메모만 PATCH). 불일치는 설정 › env 금고 상단 경고·`env ls`·`env groups` 에 멤버 이름으로 보인다.
- 승인 카드에는 값이 어디로 가는지 필드별로 적힌다: 프로젝트·환경, 종류, 위치(dotenv 파일 경로 · SSM 경로/리전/프로필 · Vercel 프로젝트/환경/scope/-Q · GitHub 저장소/environment), 기대 계정, 키 이름. 승인 전에 이걸 확인한다.

## 새 머신 부트스트랩(curl|sh)

새 맥/서버에 에이전트 환경을 세팅할 때 한 줄로 페어링→토큰 발급→route-rule 등록까지 끝낸다.

```bash
curl -fsSL https://teamspace.example.com/setup.sh | sh
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

**동시성·재승인 (설치기 후속, 2026-08-09)**

- 코드 모양(32 hex)의 진실 원천은 `lib/pairing.ts` 의 `isPairingCode`/`PAIRING_CODE_RE` 하나다(코드를 만드는 곳은 서버가 아니라 `scripts/setup/setup.sh` 의 `od -An -N16`). 라우트·승인 페이지가 각자 정규식을 인라인하면 `lib/pairing.test.ts` 의 정적 스캔이 잡는다.
- **토큰 인도는 조건부 update 한 방**이다(`tokenDeliveredAt IS NULL` + 미만료 + 같은 토큰). 1행을 고쳤을 때만 토큰을 주므로 동시 폴링 둘이 같은 토큰을 받을 수 없다. 못 잡았을 때: 다른 폴이 받아갔으면 `410 delivered`, TTL 지났으면 `410 expired`, **재승인이 끼어들어 토큰이 갈렸으면 `202 pending`**(CLI 가 다음 폴에서 새 토큰을 받게 — 여기서 410 을 주면 설치가 헛되게 죽는다).
- **승인은 code 단위 advisory lock(`pg_advisory_xact_lock`)으로 직렬화**하고 조회·회수·발급·결속을 한 트랜잭션에서 한다. 전에는 구 토큰 조회가 트랜잭션 밖이라 같은 code 동시 승인 시 **진 쪽의 유효 토큰이 아무 페어링에도 묶이지 않고 남았다**(회수 화면조차 없는 고아 토큰). ⚠ 이 잠금은 `$executeRaw` 로 호출해야 한다 — `$queryRaw` 는 반환 타입이 `void` 라 "Failed to deserialize column of type 'void'" 로 죽는다(가짜 tx 를 쓰는 단위 테스트로는 안 걸린다).
- **재승인 시 구 멤버십도 `status:"removed"`** 로 내린다(`/api/agent-tokens/<id>` DELETE 와 같은 처리). 토큰만 회수하면 같은 머신을 반복 페어링할수록 **쓸 수 없는 토큰을 가진 팀원**이 멤버 목록·담당자 드롭다운에 쌓였다.
| `GET /setup.sh`(`/api/setup/script`) | 없음(공개 정적) | curl 설치기 스크립트 서빙 |
| `GET /setup/hooks/[name]`(`/api/setup/hooks/[name]`) | 없음(화이트리스트된 name만 공개 정적) | 전역 훅 파일 서빙 |

## 주의

- 순수 로직은 TDD(`lib/*.test.ts`, vitest), 라우트/UI는 브라우저 검증이 이 레포 방침.
- 새 API/화면은 기존 `app/api/*/route.ts`·`components/ws/*` 패턴을 따른다(`runtime="nodejs"`, `@/lib/prisma`, `@/lib/workspace`).
- 디자인 동기화 기준: `docs/teamspace/DESIGN-SYNC.md`.
- **이 스킬·CLI를 최신으로**: `app/api` 라우트나 워크스페이스 데이터 기능을 추가/변경하면 **같은 커밋에서 이 SKILL.md + `scripts/ws.ts`(필요시 `scripts/ws.test.ts`)를 함께 갱신**한다(AGENTS.md 규칙). 패리티 테스트가 깨지면 동기화가 빠진 것이다.
