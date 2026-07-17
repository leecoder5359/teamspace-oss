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

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-ws-token": token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
    description: "워크스페이스 컨텍스트 스냅샷(팀 레슨·열린 태스크·문서·결정·리스크·용어). cwd 를 주면 프로젝트 스코프.",
    inputSchema: { cwd: z.string().optional() },
  },
  async ({ cwd }) => jsonResult(await api("GET", `/api/context?format=md${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`)),
);

server.registerTool(
  "task_list",
  {
    description: "태스크 목록. assignee='me' 면 내 담당만, board 로 특정 보드 지정.",
    inputSchema: { board: z.string().optional(), assignee: z.string().optional() },
  },
  async ({ board, assignee }) => {
    const q = new URLSearchParams();
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
    description: "보드에 태스크(행) 생성. props 는 propId→값. Idempotency-Key 로 재시도 안전.",
    inputSchema: { boardId: z.string(), props: z.record(z.string(), z.unknown()) },
  },
  async ({ boardId, props }) => jsonResult(await api("POST", `/api/databases/${boardId}/rows`, { props })),
);

server.registerTool(
  "doc_list",
  { description: "문서 목록(kind=doc).", inputSchema: {} },
  async () => {
    const r = (await api("GET", "/api/pages")) as { pages: { id: string; title: string; kind: string; projectId: string | null }[] };
    return jsonResult(r.pages.filter((p) => p.kind === "doc"));
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
    description: "새 문서 생성(TeamSpace 가 문서의 단일 저장소 — 레포 md 대신 항상 이걸 사용).",
    inputSchema: { title: z.string(), projectId: z.string().optional(), parentId: z.string().optional() },
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
  { description: "팀 작업규칙·레슨 목록.", inputSchema: { projectId: z.string().optional() } },
  async ({ projectId }) => jsonResult(await api("GET", `/api/lessons${projectId ? `?projectId=${projectId}` : ""}`)),
);

server.registerTool(
  "lesson_add",
  {
    description: "팀 작업규칙·레슨 등록 — 모든 팀원·에이전트 세션에 자동 주입된다. 팀이 알아야 할 규범은 반드시 여기로.",
    inputSchema: { title: z.string(), body: z.string(), projectId: z.string().optional() },
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
  { description: "내 알림 인박스(배정·멘션·승인·마감).", inputSchema: { unread: z.boolean().optional() } },
  async ({ unread }) => jsonResult(await api("GET", `/api/notifications${unread ? "?unread=1" : ""}`)),
);

server.registerTool(
  "activity_list",
  { description: "워크스페이스 활동 피드(누가 무엇을 언제).", inputSchema: { limit: z.number().optional() } },
  async ({ limit }) => jsonResult(await api("GET", `/api/activity?limit=${limit ?? 30}`)),
);

server.registerTool(
  "search",
  { description: "문서·결정 전문 검색.", inputSchema: { q: z.string() } },
  async ({ q }) => jsonResult(await api("GET", `/api/search?q=${encodeURIComponent(q)}`)),
);

async function main() {
  if (!token) {
    console.error("teamspace-mcp: 토큰 없음 — ~/.claude/teamspace.json 또는 WS_TOKEN 설정 필요");
  }
  await server.connect(new StdioServerTransport());
}

void main();
