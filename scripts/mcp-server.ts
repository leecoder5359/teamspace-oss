/**
 * TeamSpace MCP 서버 (W8 agent-13) — HTTP API 를 네이티브 MCP 툴로 노출한다.
 *
 * 실행: pnpm exec tsx scripts/mcp-server.ts   (레포 .mcp.json 이 자동 등록)
 * 다른 레포/머신: claude mcp add teamspace -- pnpm --dir <이 레포 경로> exec tsx scripts/mcp-server.ts
 * 인증: WS_BASE/WS_TOKEN env > ~/.claude/teamspace.json { base, token } (에이전트 토큰 wst_…)
 *
 * 스킬(.claude/skills/teamspace)·ws CLI 는 유지 — MCP 는 도구 호출 마찰을 줄이는 네이티브 표면.
 * 라우트를 추가/변경하면 AGENTS.md 규칙에 따라 이 서버의 해당 툴도 같은 커밋에서 갱신한다.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fetchWithRetry } from "../lib/retryAfter";
import { isTaskNote } from "../lib/taskNotes";
import { DOC_TYPES } from "../lib/docOrganize";
import { bundleFromPath } from "../lib/sites/pathBundle";

function config(): { base: string; token: string } {
  let file: { base?: string; token?: string } = {};
  try {
    file = JSON.parse(readFileSync(join(homedir(), ".claude", "teamspace.json"), "utf8"));
  } catch {
    /* 설정 파일 없음 */
  }
  return {
    base: process.env.WS_BASE || file.base || "http://localhost:3002",
    token: process.env.WS_TOKEN || file.token || "",
  };
}

const { base, token } = config();

async function api(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
  const doFetch = (signal?: AbortSignal) => fetch(`${base}${path}`, {
    method,
    headers: {
      "x-ws-token": token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      // 종전엔 task_add 설명이 '재시도 안전'을 광고하면서 헤더를 보내지 않았다 —
      // 모델이 그 설명을 믿고 재시도하면 태스크가 조용히 두 개 쌓였다(전수조사 D9).
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const { res } = await fetchWithRetry(doFetch, {
    onRetry: (wait) => console.error(`429 — ${Math.ceil(wait / 1000)}s 뒤 재시도`),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

function jsonResult(v: unknown) {
  return { content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] };
}

const server = new McpServer({ name: "teamspace", version: "1.0.0" });

server.registerTool(
  "context_get",
  {
    description:
      "워크스페이스 컨텍스트 스냅샷(팀 레슨·열린 태스크·문서·결정·리스크·용어). cwd 를 주면 프로젝트 스코프. 기본은 압축본(≈10KB). full=true 는 전체(100KB+) — 꼭 필요할 때만.",
    inputSchema: { cwd: z.string().optional(), full: z.boolean().optional() },
  },
  async ({ cwd, full }) =>
    jsonResult(await api("GET", `/api/context?format=json${full ? "" : "&compact=1"}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`)),
);

server.registerTool(
  "task_list",
  {
    description: "태스크 목록. 기본은 열린 태스크 50건. 전체는 status='all', 더 보려면 limit(최대 200). assignee='me' 면 내 담당만, board 로 특정 보드 지정. 응답 {total,shown,tasks} — total 은 status·assignee 필터 뒤·limit 앞의 건수(status=open 이면 완료·취소 제외), shown 은 실제로 담긴 수.",
    inputSchema: {
      board: z.string().optional(),
      assignee: z.string().optional(),
      status: z.enum(["open", "all"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ board, assignee, status, limit }) => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (limit) q.set("limit", String(limit));
    if (board) q.set("board", board);
    if (assignee) q.set("assignee", assignee);
    return jsonResult(await api("GET", `/api/tasks${q.size ? `?${q}` : ""}`));
  },
);

server.registerTool(
  "task_claim",
  {
    description: "태스크 원자적 클레임 — 담당자=나, 상태=진행 중. 이미 잡혀 있으면 에러(409). 태스크를 맡을 때 반드시 이걸 쓴다.",
    inputSchema: { rowId: z.string(), force: z.boolean().optional() },
  },
  async ({ rowId, force }) => jsonResult(await api("POST", `/api/rows/${rowId}/claim`, force ? { force: true } : {})),
);

server.registerTool(
  "task_update",
  {
    description: "태스크 속성 갱신(props 병합)·문서 연결. propId→값 매핑은 board_get 으로 확인. expectedUpdatedAt 로 낙관적 잠금.",
    inputSchema: {
      rowId: z.string(),
      props: z.record(z.string(), z.unknown()).optional(),
      contentPageId: z.string().nullable().optional(),
      expectedUpdatedAt: z.string().optional(),
    },
  },
  async ({ rowId, ...rest }) => jsonResult(await api("PATCH", `/api/rows/${rowId}`, rest)),
);

server.registerTool(
  "task_move",
  {
    description:
      "태스크(행)를 다른 보드로 이동(같은 행 id 유지 — 코멘트·체크리스트·문서 연결 보존). 속성은 이름+타입으로 매핑하고 select 는 옵션 이름으로 맞춘다. 대상에 없는 속성·옵션·다른 보드를 가리키는 relation 은 버리고 dropped 로 보고한다. **먼저 dryRun:true 로 보고를 확인**하고 옮긴다. createMissingOptions:true 면 없는 select 옵션을 대상에 만든다. 하위 항목이 있으면 409. task_update 의 position 은 같은 보드 안 순서 변경일 뿐이다.",
    inputSchema: {
      rowId: z.string(),
      targetDatabaseId: z.string(),
      dryRun: z.boolean().optional(),
      createMissingOptions: z.boolean().optional(),
      expectedUpdatedAt: z.string().optional(),
    },
  },
  async ({ rowId, ...rest }) => jsonResult(await api("POST", `/api/rows/${rowId}/move`, rest)),
);

server.registerTool(
  "board_get",
  {
    description: "보드 상세(속성 정의·옵션 id·행). 상태 변경 전 옵션 id 조회용.",
    inputSchema: { boardId: z.string() },
  },
  async ({ boardId }) => jsonResult(await api("GET", `/api/databases/${boardId}`)),
);

server.registerTool(
  "task_add",
  {
    description:
      "보드에 태스크(행) 생성. props 는 propId→값. 재시도할 때는 같은 idempotencyKey 를 다시 보내면 이중 생성되지 않는다(키를 안 보내면 매번 새로 생성된다).",
    inputSchema: {
      boardId: z.string(),
      props: z.record(z.string(), z.unknown()),
      idempotencyKey: z.string().optional(),
    },
  },
  async ({ boardId, props, idempotencyKey }) =>
    jsonResult(await api("POST", `/api/databases/${boardId}/rows`, { props }, idempotencyKey)),
);

server.registerTool(
  "doc_list",
  {
    description:
      "문서 목록(kind=doc). 태스크 설명([태스크 설명]/docType=task_note)은 기본 제외(includeTaskNotes=true 로 포함). 보관된 문서도 기본 제외(archived=only 는 보관함만, archived=all 은 둘 다). updatedAt 내림차순, limit 기본 30. { total, shown, docs } 반환 — total>shown 이면 projectId·folder·docType 으로 좁혀라.",
    inputSchema: {
      projectId: z.string().optional(),
      folder: z.string().optional(),
      docType: z.string().optional(),
      includeTaskNotes: z.boolean().optional(),
      archived: z.enum(["only", "all"]).optional(),
      limit: z.number().optional(),
    },
  },
  async ({ projectId, folder, docType, includeTaskNotes, archived, limit }) => {
    type P = { id: string; title: string; kind: string; projectId: string | null; docType?: string | null; parentId?: string | null; updatedAt?: string };
    const r = (await api("GET", `/api/pages${archived === "only" ? "?archived=1" : archived === "all" ? "?archived=all" : ""}`)) as { pages: P[] };
    const byId = new Map(r.pages.map((p) => [p.id, p]));
    const filtered = r.pages
      .filter((p) => p.kind === "doc")
      .filter((p) => includeTaskNotes || !isTaskNote(p))
      .filter((p) => !projectId || p.projectId === projectId)
      .filter((p) => !docType || p.docType === docType)
      .filter((p) => !folder || (p.parentId ? byId.get(p.parentId)?.title === folder : false))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const docs = filtered.slice(0, limit ?? 30).map((p) => ({
      id: p.id, title: p.title, projectId: p.projectId, docType: p.docType ?? null, parentId: p.parentId ?? null, updatedAt: p.updatedAt ?? null,
    }));
    return jsonResult({ total: filtered.length, shown: docs.length, docs });
  },
);

server.registerTool(
  "doc_read",
  { description: "문서 본문(markdown)+rev 읽기.", inputSchema: { pageId: z.string() } },
  async ({ pageId }) => jsonResult(await api("GET", `/api/pages/${pageId}`)),
);

server.registerTool(
  "doc_save",
  {
    description: "문서 본문 저장. baseRev(직전 doc_read 의 page.rev)를 넘기면 충돌 시 409 — 항상 넘겨라.",
    inputSchema: { pageId: z.string(), markdown: z.string(), title: z.string().optional(), baseRev: z.number().optional() },
  },
  async ({ pageId, ...rest }) => jsonResult(await api("PUT", `/api/pages/${pageId}`, rest)),
);

server.registerTool(
  "doc_create",
  {
    description:
      "새 문서 생성(TeamSpace 가 문서의 단일 저장소 — 레포 md 대신 항상 이걸 사용). 새 문서는 folder(부모 폴더 제목, 없으면 생성)를 지정한다. 태스크 설명은 docType task_note.",
    inputSchema: {
      title: z.string(),
      projectId: z.string().optional(),
      parentId: z.string().optional(),
      folder: z.string().optional(),
      docType: z.enum(DOC_TYPES).optional(),
    },
  },
  async (args) => jsonResult(await api("POST", "/api/pages", { ...args, kind: "doc" })),
);

server.registerTool(
  "doc_comment",
  { description: "문서 코멘트 작성. @이름 멘션 시 해당 멤버에게 알림.", inputSchema: { pageId: z.string(), body: z.string() } },
  async ({ pageId, body }) => jsonResult(await api("POST", `/api/pages/${pageId}/comments`, { body })),
);

server.registerTool(
  "lesson_list",
  {
    description:
      "팀 작업규칙·레슨 목록(id·제목·범위·주입 방식만 — 전문은 lesson_get). projectId 를 주면 전역+그 프로젝트(+내 개인). q 는 제목 부분일치(대소문자 무시), mode 로 거르기(ondemand = 세션에 주입되지 않는 '필요할 때만' 레슨 — 관련 작업이면 여기서 찾는다), limit 기본 100(최대 300). 응답 {total,shown,lessons} — scope 는 personal|<projectId>|stack:<tag>|global, mode 는 required|default|ondemand. total 은 필터 뒤·limit 앞의 건수.",
    inputSchema: {
      projectId: z.string().optional(),
      q: z.string().optional(),
      mode: z.enum(["required", "default", "ondemand"]).optional(),
      limit: z.number().int().min(1).max(300).optional(),
    },
  },
  async ({ projectId, q, mode, limit }) => {
    // 본문까지 돌려주면 수십~백 KB 가 되어 도구 결과로 쓸 수 없다 — 목록은 색인만.
    const qs = new URLSearchParams();
    if (projectId) qs.set("projectId", projectId);
    if (q) qs.set("q", q);
    if (mode) qs.set("mode", mode);
    qs.set("limit", String(limit ?? 100));
    const { lessons, total } = (await api("GET", `/api/lessons?${qs}`)) as {
      lessons: { id: string; title: string; projectId: string | null; stack: string | null; personal?: boolean; mode?: string }[];
      total: number;
    };
    return jsonResult({
      total,
      shown: lessons.length,
      lessons: lessons.map((l) => ({
        id: l.id,
        title: l.title,
        scope: l.personal ? "personal" : (l.projectId ?? (l.stack ? `stack:${l.stack}` : "global")),
        mode: l.mode ?? "default",
      })),
    });
  },
);

server.registerTool(
  "lesson_get",
  { description: "레슨 전문(실사례·원인·처방). 세션 주입에는 제목·요약만 있으니, 관련 작업을 시작할 때 읽는다.", inputSchema: { id: z.string() } },
  async ({ id }) => jsonResult(await api("GET", `/api/lessons/${id}`)),
);

server.registerTool(
  "lesson_add",
  {
    description:
      "팀 작업규칙·레슨 등록 — 세션에 자동 주입된다. 범위를 정확히(하나만): 특정 레포에서만 의미 있으면 projectId, 특정 기술 스택(next·supabase 등)을 쓰는 프로젝트에만 해당하면 stack, 나(이 토큰을 발급한 사람)의 개인 습관·선호면 personal:true, 어느 레포에나 통하는 규범만 모두 비워 전역으로. 전역은 모든 레포 세션에 들어간다. mode: required(필수 — 항상 제목+요약, 예산 먼저; 어기면 사고 나는 규칙에만) · default(기본) · ondemand(세션 주입 제외 — lesson_list 로만 찾는 드문 상황용).",
    inputSchema: {
      title: z.string(),
      body: z.string(),
      projectId: z.string().optional(),
      stack: z.string().optional(),
      personal: z.boolean().optional(),
      mode: z.enum(["required", "default", "ondemand"]).optional(),
    },
  },
  async (args) => jsonResult(await api("POST", "/api/lessons", args)),
);

server.registerTool(
  "decision_add",
  {
    description: "결정 기록(기본 accepted). 방향을 가르는 확정 사항은 반드시 등록.",
    inputSchema: { title: z.string(), context: z.string().optional(), decision: z.string().optional(), projectId: z.string().optional() },
  },
  async (args) => jsonResult(await api("POST", "/api/decisions", { ...args, status: "accepted" })),
);

server.registerTool(
  "propose",
  {
    description: "팀 지식 승격 제안(제안+승인 관문). 이 세션에서 배운 팀 규범/확정 사항을 lesson 또는 decision 으로 제안 — admin 승인 후 등록·전 세션 주입. 확신이 높고 admin 이면 lesson_add/decision_add 직접 사용.",
    inputSchema: { kind: z.enum(["lesson", "decision"]), title: z.string(), body: z.string(), projectId: z.string().optional() },
  },
  async (args) => jsonResult(await api("POST", "/api/proposals", args)),
);

server.registerTool(
  "inbox_list",
  { description: "내 알림 인박스(배정·멘션·승인·마감). group:true 면 같은 종류·링크 24h 묶음(groups)으로.", inputSchema: { unread: z.boolean().optional(), group: z.boolean().optional(), type: z.string().optional().describe("쉼표 구분: approval,assigned,mention,due,proposal,shared") } },
  async ({ unread, group, type }) => {
    const qs = new URLSearchParams();
    if (unread) qs.set("unread", "1");
    if (group) qs.set("group", "1");
    if (type) qs.set("type", type);
    return jsonResult(await api("GET", `/api/notifications${qs.size ? `?${qs}` : ""}`));
  },
);

server.registerTool(
  "activity_list",
  { description: "워크스페이스 활동 피드(누가 무엇을 언제).", inputSchema: { limit: z.number().optional() } },
  async ({ limit }) => jsonResult(await api("GET", `/api/activity?limit=${limit ?? 30}`)),
);

server.registerTool(
  "search",
  { description: "문서·결정 전문 검색. 상위 결과에는 지식 그래프 이웃(관계·근거 태그)이 붙는다.", inputSchema: { q: z.string() } },
  async ({ q }) => jsonResult(await api("GET", `/api/search?q=${encodeURIComponent(q)}&neighbors=1`)),
);

server.registerTool(
  "graph_neighbors",
  {
    description: "지식 그래프에서 노드(문서·결정·레슨·태스크·리스크·프로젝트 id)의 이웃을 관계 종류(link·ref·mention·contains·pair·related)와 근거 태그(추출·추론·모호)로 반환. 원문을 다 읽기 전에 관계부터 확인할 때.",
    inputSchema: { id: z.string(), depth: z.number().optional() },
  },
  async ({ id, depth }) => jsonResult(await api("GET", `/api/graph/neighbors?id=${encodeURIComponent(id)}&depth=${depth ?? 1}`)),
);

server.registerTool(
  "site_list",
  {
    description: "퍼블리시한 HTML 페이지 목록(초대 이메일로만 열리는 /s/<slug> 링크).",
    inputSchema: {},
  },
  async () => jsonResult(await api("GET", "/api/sites")),
);

server.registerTool(
  "site_publish",
  {
    description:
      "로컬 HTML 파일·폴더·zip 을 퍼블리시한다. 초대한 이메일로 Google 로그인한 사람만 볼 수 있는 링크를 돌려준다. siteId 를 주면 그 사이트의 새 버전. 폴더는 index.html 이 최상위에 있어야 하고, 숨김 파일·node_modules 는 담지 않는다. slug 는 설명형 주소(영문 소문자·숫자·하이픈, 3~60자 — /s/<slug>)로, 없으면 무작위. siteId 와 함께 주면 그 사이트 주소를 바꾸고 옛 주소는 새 주소로 넘어간다. 하위 페이지는 /s/<slug>/pages/<이름> 으로 바로 링크된다.",
    inputSchema: {
      path: z.string(),
      title: z.string().optional(),
      siteId: z.string().optional(),
      invites: z.array(z.string()).optional(),
      slug: z.string().optional(),
    },
  },
  async ({ path, title, siteId, invites, slug }) => {
    const b = bundleFromPath(path);
    // 기존 사이트 주소 변경은 올리기 전에 — 형식·중복 오류면 새 버전을 만들지 않는다.
    if (siteId && slug) await api("PATCH", `/api/sites/${siteId}`, { slug });
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(b.data)]), b.filename);
    if (title && !siteId) form.set("title", title);
    if (slug && !siteId) form.set("slug", slug);
    const target = siteId ? `/api/sites/${siteId}/versions` : "/api/sites";
    const res = await fetch(`${base}${target}`, { method: "POST", headers: { "x-ws-token": token }, body: form });
    const payload = (await res.json().catch(() => ({}))) as { site?: { id: string }; url?: string; warnings?: string[]; version?: number };
    if (!res.ok) throw new Error(`POST ${target} → ${res.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    const id = siteId ?? payload.site!.id;
    let added: string[] = [];
    if (invites?.length) {
      added = ((await api("POST", `/api/sites/${id}/invites`, { emails: invites })) as { added: string[] }).added;
    }
    const detail = (await api("GET", `/api/sites/${id}`)) as { url: string };
    return jsonResult({
      siteId: id,
      url: detail.url,
      version: payload.version ?? 1,
      invited: added,
      warnings: payload.warnings ?? [],
      shareText: added.length ? `이 링크를 열고 ${added.join(", ")} 계정으로 Google 로그인하세요: ${detail.url}` : null,
    });
  },
);

async function main() {
  if (!token) {
    console.error("teamspace-mcp: 토큰 없음 — ~/.claude/teamspace.json 또는 WS_TOKEN 설정 필요");
  }
  await server.connect(new StdioServerTransport());
}

void main();
