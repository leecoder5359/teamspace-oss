/**
 * ws — TeamSpace 워크스페이스 CLI (반복작업 + 기본 템플릿 헬퍼).
 *
 * 스킬(.claude/skills/teamspace/SKILL.md)의 반복 recipe를 코드로 옮긴 단일 진입점.
 * 모든 명령은 **HTTP API(/api/*) 경유**라서 라우트의 검증·file-first·위키링크
 * 로직을 그대로 타고, 실행 중인 앱과 100% 동일하게 동작한다(DB 직접 접근 안 함).
 *
 * 대상 서버: WS_BASE 환경변수 또는 http://localhost:3002 (dev 서버가 떠 있어야 함).
 *
 * Usage:
 *   pnpm ws <group> <action> [args] [--flags]
 *   pnpm ws help                       # 전체 명령 목록
 *   pnpm ws task add "버그 수정" --status "진행 중" --due 2026-07-01
 *   pnpm ws task done <rowId>
 *   pnpm ws doc new "회의록" --project <id>
 *   pnpm ws decision add "DB는 SQLite" --status accepted
 *
 * ── 동기화 규칙 (AGENTS.md) ───────────────────────────────────────────────
 * app/api 의 route.ts 나 워크스페이스 데이터 기능을 추가/변경하면, 같은 커밋에서
 * 이 파일의 명령·페이로드와 SKILL.md 를 함께 갱신한다. scripts/ws.test.ts 가
 * 모든 명령의 엔드포인트(ep) 가 실제 라우트로 존재하는지 패리티 검증한다.
 */

import "dotenv/config";
import { findAssigneeProp, findDateProp, findStatusProp, optionIdByName } from "../lib/taskProps"; // .env 자동 로드 — WS_TOKEN/AUTH_CLI_TOKEN 인증 (감사 agent-1)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// 토큰 체인: WS_TOKEN > ~/.claude/teamspace.json(에이전트 토큰). AUTH_CLI_TOKEN 폴백은
// 서버에서 그 경로를 제거해(D12) 함께 뺐다 — 남겨두면 401 을 "토큰이 없다"로 오인하게 만든다.
function fileConfig(): { base?: string; token?: string } {
  try {
    return JSON.parse(readFileSync(`${homedir()}/.claude/teamspace.json`, "utf8"));
  } catch {
    return {};
  }
}
const FILE_CFG = fileConfig();
const BASE = process.env.WS_BASE ?? FILE_CFG.base ?? "http://localhost:3002";
const TOKEN = process.env.WS_TOKEN ?? FILE_CFG.token;

// ── HTTP ──────────────────────────────────────────────────────────────────
async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (TOKEN) headers["x-ws-token"] = TOKEN;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      `${BASE} 에 연결할 수 없습니다. dev 서버를 먼저 띄우세요: pnpm exec next dev -p 3002`,
    );
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : text;
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

// ── 인자 파싱 ───────────────────────────────────────────────────────────────
interface Args {
  pos: string[];
  flags: Record<string, string | boolean>;
}
function parse(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}
function flag(a: Args, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = a.flags[n];
    if (typeof v === "string") return v;
  }
  return undefined;
}
function bool(a: Args, name: string): boolean {
  return a.flags[name] === true || a.flags[name] === "true";
}

// ── 출력 ────────────────────────────────────────────────────────────────────
function out(v: unknown): void {
  console.log(typeof v === "string" ? v : JSON.stringify(v));
}
function label(it: Record<string, unknown>): string {
  const primary =
    it.title ?? it.term ?? it.name ?? it.text ?? it.version ?? it.id ?? "";
  return `${String(it.id ?? "")}\t${String(primary)}`;
}
function listItems(r: unknown, key: string): void {
  const items = (r as Record<string, unknown>)[key];
  if (!Array.isArray(items)) return out(r);
  for (const it of items) out(label(it as Record<string, unknown>));
}

// ── 보드/태스크 공용 ─────────────────────────────────────────────────────────
interface PropLite {
  id: string;
  name: string;
  type: string;
  config: { options?: { id: string; name: string }[] };
}
interface BoardData {
  page: { id: string; title: string };
  properties: PropLite[];
  rows: { id: string; props: Record<string, unknown> }[];
}

async function loadBoard(boardId?: string): Promise<BoardData> {
  let id = boardId;
  if (!id) {
    const pages = (await api("GET", "/api/pages")) as { pages: { id: string; kind: string }[] };
    const db = pages.pages.find((p) => p.kind === "database");
    if (!db) throw new Error("보드(database 페이지)가 없습니다. `pnpm ws board new`로 생성하세요.");
    id = db.id;
  }
  return (await api("GET", `/api/databases/${id}`)) as BoardData;
}
/** rowId 가 속한 보드를 전 보드에서 탐색. task done 이 기본 보드의 상태 propId·옵션을
 *  다른 보드 행에 병합하던 사고 방지(실사례 2026-07-19: loyo 감사 보드 행 5건이 기본 보드
 *  propId 로 '완료' 처리돼 실제 상태는 진행 중으로 남았다). */
async function findBoardOfRow(rowId: string): Promise<BoardData> {
  const pages = (await api("GET", "/api/pages")) as { pages: { id: string; kind: string }[] };
  for (const p of pages.pages.filter((x) => x.kind === "database")) {
    const b = (await api("GET", `/api/databases/${p.id}`)) as BoardData;
    if (b.rows.some((r) => r.id === rowId)) return b;
  }
  throw new Error(`rowId ${rowId} 가 속한 보드를 찾지 못했습니다.`);
}
function prop(b: BoardData, re: RegExp, type?: string): PropLite | undefined {
  return b.properties.find((p) => re.test(p.name) && (type ? p.type === type : true));
}
function optionId(p: PropLite | undefined, name: string): string | undefined {
  return p?.config.options?.find((o) => new RegExp(name, "i").test(o.name))?.id;
}
/** 플래그(--status/--priority/--assignee/--due/제목)를 보드 props 레코드로 변환. */
function buildProps(b: BoardData, a: Args, title?: string): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  // 속성 탐지는 서버(lib/taskProps)와 같은 규칙을 쓴다.
  //
  // 종전엔 여기 사설 정규식이 따로 있어 서버와 갈라졌다 — 담당자를 text 로만 찾아
  // person 타입 보드에서는 --assignee 가 조용히 버려졌고, 상태 속성도 폴백이 없어
  // 이름이 다른 보드에서는 --status 가 무시됐다(전수조사 D14). 쓰기(CLI)와
  // 읽기(서버)가 다른 속성을 고르면 "넣었는데 안 보인다"가 된다.
  const lite = b.properties.map((p) => ({ id: p.id, name: p.name, type: p.type as string, config: p.config }));
  const titleProp = prop(b, /이름|name|title/i, "text") ?? b.properties.find((p) => p.type === "text");
  const statusProp = findStatusProp(lite);
  const prioProp = prop(b, /우선순위|priority/i, "select");
  const asgnProp = findAssigneeProp(lite);
  const dueProp = findDateProp(lite);

  if (title && titleProp) props[titleProp.id] = title;
  const status = flag(a, "status");
  if (status && statusProp) {
    // 옵션 이름 매칭도 서버(optionIdByName: 정확 → 시작 일치)와 같은 규칙으로.
    // 종전 CLI 는 부분일치 정규식이라 '완료' 검색이 '미완료' 를 잡는 식으로 갈렸다.
    const id = optionIdByName(statusProp, status);
    if (!id) throw new Error(`상태 옵션 '${status}' 없음. 가능: ${statusProp.config?.options?.map((o) => o.name).join(", ")}`);
    props[statusProp.id] = id;
  }
  const prio = flag(a, "priority");
  if (prio && prioProp) {
    const id = optionId(prioProp, prio);
    if (!id) throw new Error(`우선순위 옵션 '${prio}' 없음. 가능: ${prioProp.config.options?.map((o) => o.name).join(", ")}`);
    props[prioProp.id] = id;
  }
  const asgn = flag(a, "assignee");
  if (asgn && asgnProp) props[asgnProp.id] = asgn; // text/person 속성 — 서버와 같은 규칙으로 찾는다
  const due = flag(a, "due");
  if (due && dueProp) props[dueProp.id] = due; // YYYY-MM-DD / ISO 문자열

  // 값을 줬는데 담을 속성이 없으면 조용히 버리지 않는다 — 종전엔 아무 말 없이
  // 사라져서 사용자는 반영된 줄 알았다(D14).
  const dropped = [
    status && !statusProp ? "--status(상태 select 속성 없음)" : null,
    prio && !prioProp ? "--priority(우선순위 select 속성 없음)" : null,
    asgn && !asgnProp ? "--assignee(담당자 text/person 속성 없음)" : null,
    due && !dueProp ? "--due(date 속성 없음)" : null,
  ].filter(Boolean);
  if (dropped.length) {
    throw new Error(`이 보드에 해당 속성이 없어 반영할 수 없습니다: ${dropped.join(", ")}`);
  }
  return props;
}

// ── 명령 레지스트리 ──────────────────────────────────────────────────────────
interface Cmd {
  name: string;
  usage: string;
  ep: string[]; // 의존 라우트 파일(app/api 기준 상대경로) — 패리티 테스트가 검증
  run: (a: Args) => Promise<void>;
}

const COMMANDS: Cmd[] = [];
function add(c: Cmd): void {
  COMMANDS.push(c);
}

// 보드 / 태스크
add({
  name: "board ls",
  usage: "board ls",
  ep: ["pages/route.ts"],
  run: async () => {
    const r = (await api("GET", "/api/pages")) as { pages: { id: string; title: string; kind: string }[] };
    for (const p of r.pages.filter((x) => x.kind === "database")) out(`${p.id}\t${p.title}`);
  },
});
add({
  name: "board new",
  usage: 'board new [title] [--parent <id>] [--project <id>]',
  ep: ["databases/route.ts"],
  run: async (a) => out(await api("POST", "/api/databases", { title: a.pos[0], parentId: flag(a, "parent"), projectId: flag(a, "project") })),
});
add({
  name: "board prop add",
  usage:
    'board prop add <boardId> <name> --type <text|number|date|select|checkbox|person|relation> [--target <보드id>]   (relation 은 --target 필수, multiselect 는 미구현이라 차단)',
  ep: ["databases/[id]/properties/route.ts"],
  run: async (a) => {
    const type = flag(a, "type");
    const target = flag(a, "target");
    if (type === "relation" && !target) throw new Error("relation 속성에는 --target <가리킬 보드id> 가 필요합니다.");
    out(
      await api("POST", `/api/databases/${a.pos[0]}/properties`, {
        name: a.pos[1],
        type,
        ...(target ? { config: { targetDatabaseId: target } } : {}),
      }),
    );
  },
});
add({
  name: "board prop opt",
  usage: 'board prop opt <boardId> <propId> --add <옵션이름> [--color <c>]',
  ep: ["databases/[id]/properties/[propId]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/databases/${a.pos[0]}/properties/${a.pos[1]}`, { addOption: { name: flag(a, "add"), color: flag(a, "color") } })),
});
add({
  name: "board prop rm",
  usage: "board prop rm <boardId> <propId>",
  ep: ["databases/[id]/properties/[propId]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/databases/${a.pos[0]}/properties/${a.pos[1]}`)),
});
add({
  name: "task ls",
  usage: "task ls [--board <id>] [--assignee <이름|me>]",
  ep: ["tasks/route.ts"],
  run: async (a) => {
    const q = new URLSearchParams();
    const b = flag(a, "board");
    const asgn = flag(a, "assignee");
    if (b) q.set("board", b);
    if (asgn) q.set("assignee", asgn);
    const qs = q.toString();
    const r = (await api("GET", `/api/tasks${qs ? `?${qs}` : ""}`)) as {
      tasks: { id: string; title: string; status: string | null; due: string | null; assignee: string | null }[];
    };
    for (const t of r.tasks) out(`${t.id}\t${t.status ?? "-"}\t${t.assignee ?? "-"}\t${t.due ?? "-"}\t${t.title}`);
  },
});
add({
  name: "task add",
  usage: 'task add <title> [--board <id>] [--status <name>] [--priority <name>] [--assignee <text>] [--due <YYYY-MM-DD>]',
  ep: ["pages/route.ts", "databases/[id]/route.ts", "databases/[id]/rows/route.ts"],
  run: async (a) => {
    const title = a.pos[0];
    if (!title) throw new Error("제목이 필요합니다: ws task add <title>");
    const b = await loadBoard(flag(a, "board"));
    const props = buildProps(b, a, title);
    out(await api("POST", `/api/databases/${b.page.id}/rows`, { props }));
  },
});
add({
  name: "task set",
  usage: 'task set <rowId> [--board <id>] [--status][--priority][--assignee][--due]   (--board 없으면 rowId 소속 보드 자동 탐색)',
  ep: ["pages/route.ts", "databases/[id]/route.ts", "rows/[id]/route.ts"],
  run: async (a) => {
    const rowId = a.pos[0];
    if (!rowId) throw new Error("rowId가 필요합니다: ws task set <rowId> --status ...");
    // task done 과 같은 이유로 기본 보드를 쓰면 안 된다 — findBoardOfRow 주석 참조
    const boardFlag = flag(a, "board");
    const b = boardFlag ? await loadBoard(boardFlag) : await findBoardOfRow(rowId);
    out(await api("PATCH", `/api/rows/${rowId}`, { props: buildProps(b, a) }));
  },
});
add({
  name: "task done",
  usage: "task done <rowId> [--board <id>]   (상태→완료. --board 없으면 rowId 소속 보드 자동 탐색)",
  ep: ["pages/route.ts", "databases/[id]/route.ts", "rows/[id]/route.ts"],
  run: async (a) => {
    const rowId = a.pos[0];
    if (!rowId) throw new Error("rowId가 필요합니다: ws task done <rowId>");
    const boardFlag = flag(a, "board");
    const b = boardFlag ? await loadBoard(boardFlag) : await findBoardOfRow(rowId);
    const statusProp = prop(b, /상태|status/i, "select");
    const doneId = optionId(statusProp, "완료|done");
    if (!doneId) throw new Error("'완료' 상태 옵션을 찾지 못했습니다.");
    out(await api("PATCH", `/api/rows/${rowId}`, { props: { [statusProp!.id]: doneId } }));
  },
});
add({
  name: "task claim",
  usage: "task claim <rowId> [--force]   (원자적 클레임 — 담당자=나, 상태=진행 중. 경쟁 시 409)",
  ep: ["rows/[id]/claim/route.ts"],
  run: async (a) => out(await api("POST", `/api/rows/${a.pos[0]}/claim`, bool(a, "force") ? { force: true } : {})),
});
add({
  name: "task link",
  usage: "task link <rowId> --doc <pageId>   (태스크↔문서 연결. --doc 없이 호출하면 해제)",
  ep: ["rows/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/rows/${a.pos[0]}`, { contentPageId: flag(a, "doc") ?? null })),
});
add({
  name: "task mine",
  usage: "task mine [--board <id>]   (내 담당 태스크 — assignee=me)",
  ep: ["tasks/route.ts"],
  run: async (a) => {
    const b = flag(a, "board");
    out(await api("GET", `/api/tasks?assignee=me${b ? `&board=${b}` : ""}`));
  },
});
add({
  name: "task mv",
  usage: "task mv <rowId> <position>   (행 순서 변경)",
  ep: ["rows/[id]/route.ts"],
  run: async (a) => {
    const [rowId, pos] = a.pos;
    if (!rowId || pos === undefined) throw new Error("usage: ws task mv <rowId> <position>");
    out(await api("PATCH", `/api/rows/${rowId}`, { position: Number(pos) }));
  },
});
add({
  name: "task rm",
  usage: "task rm <rowId>",
  ep: ["rows/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/rows/${a.pos[0]}`)),
});

// 태스크 체크리스트 / 댓글
add({
  name: "task check ls",
  usage: "task check ls <rowId>",
  ep: ["rows/[id]/checklist/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/rows/${a.pos[0]}/checklist`)) as { items: { id: string; text: string; done: boolean }[] };
    for (const it of r.items) out(`${it.id}\t${it.done ? "[x]" : "[ ]"}\t${it.text}`);
  },
});
add({
  name: "task check add",
  usage: "task check add <rowId> <text>",
  ep: ["rows/[id]/checklist/route.ts"],
  run: async (a) => out(await api("POST", `/api/rows/${a.pos[0]}/checklist`, { text: a.pos.slice(1).join(" ") })),
});
add({
  name: "task check done",
  usage: "task check done <rowId> <itemId> [--undo]",
  ep: ["rows/[id]/checklist/[itemId]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/rows/${a.pos[0]}/checklist/${a.pos[1]}`, { done: !bool(a, "undo") })),
});
add({
  name: "task check rm",
  usage: "task check rm <rowId> <itemId>",
  ep: ["rows/[id]/checklist/[itemId]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/rows/${a.pos[0]}/checklist/${a.pos[1]}`)),
});
add({
  name: "task comment ls",
  usage: "task comment ls <rowId>",
  ep: ["rows/[id]/comments/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/rows/${a.pos[0]}/comments`)) as { comments: { id: string; body: string; user: { name: string | null } | null }[] };
    for (const c of r.comments) out(`${c.id}\t${c.user?.name ?? "익명"}\t${c.body}`);
  },
});
add({
  name: "task comment add",
  usage: "task comment add <rowId> <body>",
  ep: ["rows/[id]/comments/route.ts"],
  run: async (a) => out(await api("POST", `/api/rows/${a.pos[0]}/comments`, { body: a.pos.slice(1).join(" ") })),
});

// 문서
add({
  name: "doc ls",
  usage: "doc ls",
  ep: ["pages/route.ts"],
  run: async () => {
    const r = (await api("GET", "/api/pages")) as { pages: { id: string; title: string; kind: string }[] };
    for (const p of r.pages.filter((x) => x.kind !== "database")) out(`${p.id}\t${p.title}`);
  },
});
add({
  name: "doc new",
  usage: 'doc new <title> [--project <id>] [--parent <id>]',
  ep: ["pages/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("제목이 필요합니다: ws doc new <title>");
    out(await api("POST", "/api/pages", { title: a.pos[0], kind: "doc", projectId: flag(a, "project"), parentId: flag(a, "parent") }));
  },
});
add({
  name: "doc save",
  usage: 'doc save <id> --file <path> | --md "<markdown>" [--title <t>]',
  ep: ["pages/[id]/route.ts"],
  run: async (a) => {
    const id = a.pos[0];
    if (!id) throw new Error("id가 필요합니다: ws doc save <id> --file ...");
    let markdown = flag(a, "md");
    const file = flag(a, "file");
    if (file) markdown = await (await import("node:fs/promises")).readFile(file, "utf8");
    if (markdown === undefined) throw new Error("--file 또는 --md 로 본문을 주세요.");
    out(await api("PUT", `/api/pages/${id}`, { markdown, title: flag(a, "title") }));
  },
});
add({
  name: "doc cat",
  usage: "doc cat <id>",
  ep: ["pages/[id]/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/pages/${a.pos[0]}`)) as { markdown?: string };
    out(r.markdown ?? "");
  },
});
add({
  name: "doc rm",
  usage: "doc rm <id> [--recursive]   (휴지통으로 소프트 삭제 — 복원은 trash restore)",
  ep: ["pages/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/pages/${a.pos[0]}${bool(a, "recursive") ? "?recursive=1" : ""}`)),
});
add({
  name: "doc rename",
  usage: "doc rename <id> <newTitle>",
  ep: ["pages/[id]/route.ts"],
  run: async (a) => {
    if (!a.pos[0] || !a.pos[1]) throw new Error("usage: ws doc rename <id> <newTitle>");
    out(await api("PATCH", `/api/pages/${a.pos[0]}`, { title: a.pos.slice(1).join(" ") }));
  },
});
add({
  name: "doc mv",
  usage: "doc mv <id> [--parent <id>] [--project <id>]   (폴더로 이동/프로젝트 변경; --parent 생략=루트)",
  ep: ["pages/[id]/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("usage: ws doc mv <id> [--parent <id>] [--project <id>]");
    const body: Record<string, string | null> = {};
    if (bool(a, "parent") || flag(a, "parent") !== undefined) body.parentId = flag(a, "parent") ?? null;
    if (bool(a, "project") || flag(a, "project") !== undefined) body.projectId = flag(a, "project") ?? null;
    if (Object.keys(body).length === 0) throw new Error("--parent 또는 --project 중 하나는 지정하세요.");
    out(await api("PATCH", `/api/pages/${a.pos[0]}`, body));
  },
});
add({
  name: "doc history",
  usage: "doc history <id>   (버전 목록. --rev <n> 이면 해당 버전 본문)",
  ep: ["pages/[id]/revisions/route.ts"],
  run: async (a) => {
    const rev = flag(a, "rev");
    out(await api("GET", `/api/pages/${a.pos[0]}/revisions${rev ? `?rev=${rev}` : ""}`));
  },
});
add({
  name: "doc restore",
  usage: "doc restore <id> --rev <n>   (해당 버전으로 복원 — 새 리비전으로 적재)",
  ep: ["pages/[id]/revisions/route.ts"],
  run: async (a) => out(await api("POST", `/api/pages/${a.pos[0]}/revisions`, { rev: Number(flag(a, "rev")) })),
});
add({
  name: "trash ls",
  usage: "trash ls   (휴지통 목록)",
  ep: ["trash/route.ts"],
  run: async () => out(await api("GET", "/api/trash")),
});
add({
  name: "trash restore",
  usage: "trash restore <pageId>",
  ep: ["trash/[id]/route.ts"],
  run: async (a) => out(await api("POST", `/api/trash/${a.pos[0]}`)),
});
add({
  name: "trash purge",
  usage: "trash purge <pageId>   (영구 삭제 — md 파일까지 제거)",
  ep: ["trash/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/trash/${a.pos[0]}`)),
});
add({
  name: "doc backlinks",
  usage: "doc backlinks <id>",
  ep: ["pages/[id]/backlinks/route.ts"],
  run: async (a) => out(await api("GET", `/api/pages/${a.pos[0]}/backlinks`)),
});
add({
  name: "doc project",
  usage: "doc project <pageId> [--project <projectId>]   (생략 시 미분류)",
  ep: ["pages/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/pages/${a.pos[0]}`, { projectId: flag(a, "project") ?? null })),
});

// 프로젝트
add({
  name: "project ls",
  usage: "project ls",
  ep: ["projects/route.ts"],
  run: async () => listItems(await api("GET", "/api/projects"), "projects"),
});
add({
  name: "project add",
  usage: 'project add <name> [--short <s>] [--color <blue|orange|purple|green|red|gray>] [--desc <d>]',
  ep: ["projects/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("이름이 필요합니다: ws project add <name>");
    out(await api("POST", "/api/projects", { name: a.pos[0], short: flag(a, "short"), color: flag(a, "color"), description: flag(a, "desc") }));
  },
});

// 문서 허브 (결정/리스크/QA/용어/변경이력/데이터모델/온보딩/DoD)
interface ResDef {
  group: string;
  path: string;
  listKey: string;
  fields: [string, string][]; // [첫=primary] [flag, bodyKey]
  proj?: boolean; // ?projectId= 필터 지원
}
const RESOURCES: ResDef[] = [
  { group: "decision", path: "decisions", listKey: "decisions", proj: true, fields: [["title", "title"], ["context", "context"], ["decision", "decision"], ["status", "status"], ["project", "projectId"]] },
  { group: "risk", path: "risks", listKey: "risks", proj: true, fields: [["title", "title"], ["desc", "description"], ["severity", "severity"], ["status", "status"], ["project", "projectId"]] },
  { group: "qa", path: "qa", listKey: "scenarios", proj: true, fields: [["title", "title"], ["steps", "steps"], ["expected", "expected"], ["status", "status"], ["project", "projectId"]] },
  { group: "glossary", path: "glossary", listKey: "terms", fields: [["term", "term"], ["def", "definition"]] },
  { group: "changelog", path: "changelog", listKey: "entries", fields: [["title", "title"], ["version", "version"], ["body", "body"]] },
  { group: "entity", path: "entities", listKey: "entities", fields: [["name", "name"], ["desc", "description"], ["fields", "fields"]] },
  { group: "onboarding", path: "onboarding", listKey: "steps", fields: [["title", "title"], ["body", "body"]] },
  { group: "dod", path: "dod", listKey: "items", fields: [["text", "text"]] },
];

/**
 * CLI 가 각 리소스에 대해 실제로 보내는 계약 — 패리티 테스트가 읽는다.
 *
 * 여기 없던 시절엔 MANIFEST 가 '명령 ↔ 라우트 파일 존재'만 노출해서,
 * 라우트에 PATCH 가 아예 없거나 필드를 일부만 받아도 테스트가 통과했다.
 * 실제로 set 계열 7개가 405/400 으로 죽어 있었는데 아무도 몰랐다(2026-08-07).
 */
export const RESOURCE_CONTRACTS = RESOURCES.map((r) => ({
  group: r.group,
  path: r.path,
  listKey: r.listKey,
  bodyKeys: r.fields.map(([, bodyKey]) => bodyKey),
}));

for (const r of RESOURCES) {
  add({
    name: `${r.group} ls`,
    usage: `${r.group} ls${r.proj ? " [--project <id>]" : ""}`,
    ep: [`${r.path}/route.ts`],
    run: async (a) => {
      const proj = r.proj ? flag(a, "project") : undefined;
      listItems(await api("GET", `/api/${r.path}${proj ? `?projectId=${proj}` : ""}`), r.listKey);
    },
  });
  add({
    name: `${r.group} add`,
    usage: `${r.group} add <${r.fields[0][0]}> ${r.fields.slice(1).map(([f]) => `[--${f} <v>]`).join(" ")}`,
    ep: [`${r.path}/route.ts`],
    run: async (a) => {
      const body: Record<string, unknown> = {};
      const primary = a.pos[0] ?? flag(a, r.fields[0][0]);
      if (!primary) throw new Error(`${r.fields[0][0]} 가 필요합니다: ws ${r.group} add <${r.fields[0][0]}>`);
      body[r.fields[0][1]] = primary;
      for (const [f, key] of r.fields.slice(1)) {
        const v = flag(a, f);
        if (v !== undefined) body[key] = v;
      }
      out(await api("POST", `/api/${r.path}`, body));
    },
  });
  add({
    name: `${r.group} set`,
    usage: `${r.group} set <id> ${r.fields.map(([f]) => `[--${f} <v>]`).join(" ")}`,
    ep: [`${r.path}/[id]/route.ts`],
    run: async (a) => {
      const body: Record<string, unknown> = {};
      for (const [f, key] of r.fields) {
        const v = flag(a, f);
        if (v !== undefined) body[key] = v;
      }
      out(await api("PATCH", `/api/${r.path}/${a.pos[0]}`, body));
    },
  });
  add({
    name: `${r.group} rm`,
    usage: `${r.group} rm <id>`,
    ep: [`${r.path}/[id]/route.ts`],
    run: async (a) => out(await api("DELETE", `/api/${r.path}/${a.pos[0]}`)),
  });
}
add({
  name: "dod done",
  usage: "dod done <id> [--undo]",
  ep: ["dod/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/dod/${a.pos[0]}`, { done: !bool(a, "undo") })),
});
add({
  name: "glossary extract",
  usage: "glossary extract <pageId>   (문서에서 용어 추출→기존 용어집 대조 제안; LLM)",
  ep: ["glossary/extract/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("pageId가 필요합니다: ws glossary extract <pageId>");
    const r = (await api("POST", "/api/glossary/extract", { pageId: a.pos[0] })) as {
      ok: boolean; error?: string; proposals?: { term: string; status: string; definition: string; existingDefinition?: string }[];
    };
    if (!r.ok) return out(`(추출 불가: ${r.error})`);
    for (const p of r.proposals ?? []) {
      out(`[${p.status}]\t${p.term}: ${p.definition}${p.existingDefinition ? `  (기존: ${p.existingDefinition})` : ""}`);
    }
  },
});
add({
  name: "entity extract",
  usage: "entity extract <pageId>   (문서에서 엔티티 추출→기존 데이터모델 대조 제안; LLM)",
  ep: ["entities/extract/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("pageId가 필요합니다: ws entity extract <pageId>");
    const r = (await api("POST", "/api/entities/extract", { pageId: a.pos[0] })) as {
      ok: boolean; error?: string; proposals?: { name: string; status: string; description: string; existingDescription?: string }[];
    };
    if (!r.ok) return out(`(추출 불가: ${r.error})`);
    for (const p of r.proposals ?? []) {
      out(`[${p.status}]\t${p.name}: ${p.description}${p.existingDescription ? `  (기존: ${p.existingDescription})` : ""}`);
    }
  },
});
add({
  name: "dod extract",
  usage: "dod extract <pageId>   (문서에서 완료 기준 추출→기존 DoD 대조 제안; LLM)",
  ep: ["dod/extract/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("pageId가 필요합니다: ws dod extract <pageId>");
    const r = (await api("POST", "/api/dod/extract", { pageId: a.pos[0] })) as {
      ok: boolean; error?: string; proposals?: { text: string; status: string }[];
    };
    if (!r.ok) return out(`(추출 불가: ${r.error})`);
    for (const p of r.proposals ?? []) out(`[${p.status}]\t${p.text}`);
  },
});
add({
  name: "onboarding extract",
  usage: "onboarding extract <pageId>   (문서에서 온보딩 단계 추출→기존 단계 대조 제안; LLM)",
  ep: ["onboarding/extract/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("pageId가 필요합니다: ws onboarding extract <pageId>");
    const r = (await api("POST", "/api/onboarding/extract", { pageId: a.pos[0] })) as {
      ok: boolean; error?: string; proposals?: { title: string; body: string; status: string; existingBody?: string }[];
    };
    if (!r.ok) return out(`(추출 불가: ${r.error})`);
    for (const p of r.proposals ?? []) {
      out(`[${p.status}]\t${p.title}: ${p.body}${p.existingBody ? `  (기존: ${p.existingBody})` : ""}`);
    }
  },
});
add({
  name: "qa extract",
  usage: "qa extract <pageId> [--project <id>]   (문서에서 QA 시나리오 추출→기존 시나리오 대조 제안; LLM)",
  ep: ["qa/extract/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("pageId가 필요합니다: ws qa extract <pageId>");
    const r = (await api("POST", "/api/qa/extract", { pageId: a.pos[0], projectId: flag(a, "project") })) as {
      ok: boolean; error?: string; proposals?: { title: string; steps: string; expected: string; status: string }[];
    };
    if (!r.ok) return out(`(추출 불가: ${r.error})`);
    for (const p of r.proposals ?? []) out(`[${p.status}]\t${p.title}: ${p.expected || p.steps}`);
  },
});

// 승인
add({
  name: "approval ls",
  usage: "approval ls",
  ep: ["approvals/route.ts"],
  run: async () => listItems(await api("GET", "/api/approvals"), "approvals"),
});
add({
  name: "approval add",
  usage: 'approval add <title> --body <b> [--kind <general|status|triage|doc|project|deploy>] [--high] [--channel <id>] [--project <projectId>]',
  ep: ["approvals/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("제목이 필요합니다: ws approval add <title> --body ...");
    out(await api("POST", "/api/approvals", { title: a.pos[0], body: flag(a, "body"), kind: flag(a, "kind"), highRisk: bool(a, "high"), channel: flag(a, "channel"), projectId: flag(a, "project") }));
  },
});
add({
  name: "approval resolve",
  usage: "approval resolve <id> --status <approved|rejected|additional> [--text <t>]",
  ep: ["approvals/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/approvals/${a.pos[0]}`, { status: flag(a, "status"), responseText: flag(a, "text") })),
});

// 리마인더
add({
  name: "remind ls",
  usage: "remind ls [--board <id>]",
  ep: ["schedules/route.ts"],
  run: async (a) => {
    const b = flag(a, "board");
    listItems(await api("GET", `/api/schedules${b ? `?databasePageId=${b}` : ""}`), "schedules");
  },
});
add({
  name: "remind add",
  usage: 'remind add --text <t> (--at <ISO> | --every <daily|weekly:MON> --time <HH:MM>) [--channel <id>] [--board <id>]',
  ep: ["schedules/route.ts"],
  run: async (a) => out(await api("POST", "/api/schedules", { remindAt: flag(a, "at"), repeat: flag(a, "every"), time: flag(a, "time"), text: flag(a, "text"), channelId: flag(a, "channel"), databasePageId: flag(a, "board") })),
});
add({
  name: "remind rm",
  usage: "remind rm <id>",
  ep: ["schedules/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/schedules/${a.pos[0]}`)),
});

// 멤버 / 워크스페이스
/* ── 공유 범위 (격차 D3) ──
   페이지·프로젝트 모두 같은 모양: shares(조회) / share(부여) / unshare(회수) / restrict(잠금 전환).
   부여 주체는 --user 또는 --team 중 하나. 잠그지 않은 페이지에도 부여할 수 있다(범위를 넓히는 쪽). */
add({
  name: "page shares",
  usage: "page shares <pageId>   (공유 범위·부여 목록)",
  ep: ["pages/[id]/grants/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/pages/${a.pos[0]}/grants`)) as {
      visibility: string;
      canManage: boolean;
      adminBypass: boolean;
      grants: { id: string; level: string; user?: { name: string; email: string } | null; team?: { name: string } | null }[];
    };
    out(`범위: ${r.visibility}${r.visibility === "restricted" ? " (부여받은 사람만)" : " (위를 따름)"}`);
    for (const g of r.grants) out(`${g.id}\t${g.level}\t${g.user ? `@${g.user.name}` : `#${g.team?.name}`}`);
    if (r.adminBypass) out("주의: 워크스페이스 admin 은 비공개 페이지도 볼 수 있습니다(확정 정책).");
    if (!r.canManage) out("(읽기 전용 — 이 페이지를 편집할 수 있어야 범위를 바꿉니다)");
  },
});
add({
  name: "page restrict",
  usage: "page restrict <pageId> <on|off>   (on=부여받은 사람만, off=위를 따름)",
  ep: ["pages/[id]/grants/route.ts"],
  run: async (a) =>
    out(
      await api("PATCH", `/api/pages/${a.pos[0]}/grants`, {
        visibility: a.pos[1] === "off" ? "inherit" : "restricted",
      }),
    ),
});
add({
  name: "page share",
  usage: "page share <pageId> (--user <userId> | --team <teamId>) [--level view|edit]",
  ep: ["pages/[id]/grants/route.ts"],
  run: async (a) =>
    out(
      await api("POST", `/api/pages/${a.pos[0]}/grants`, {
        userId: flag(a, "user"),
        teamId: flag(a, "team"),
        level: flag(a, "level") ?? "view",
      }),
    ),
});
add({
  name: "page unshare",
  usage: "page unshare <pageId> <grantId>",
  ep: ["pages/[id]/grants/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/pages/${a.pos[0]}/grants?grantId=${a.pos[1]}`)),
});
add({
  name: "project shares",
  usage: "project shares <projectId>   (프로젝트 공유 범위·부여 목록)",
  ep: ["projects/[id]/grants/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/projects/${a.pos[0]}/grants`)) as {
      visibility: string;
      canManage: boolean;
      grants: { id: string; level: string; user?: { name: string } | null; team?: { name: string } | null }[];
    };
    out(`범위: ${r.visibility}`);
    for (const g of r.grants) out(`${g.id}\t${g.level}\t${g.user ? `@${g.user.name}` : `#${g.team?.name}`}`);
    if (!r.canManage) out("(읽기 전용)");
  },
});
add({
  name: "project restrict",
  usage: "project restrict <projectId> <on|off>",
  ep: ["projects/[id]/grants/route.ts"],
  run: async (a) =>
    out(
      await api("PATCH", `/api/projects/${a.pos[0]}/grants`, {
        visibility: a.pos[1] === "off" ? "inherit" : "restricted",
      }),
    ),
});
add({
  name: "project share",
  usage: "project share <projectId> (--user <userId> | --team <teamId>) [--level view|edit]",
  ep: ["projects/[id]/grants/route.ts"],
  run: async (a) =>
    out(
      await api("POST", `/api/projects/${a.pos[0]}/grants`, {
        userId: flag(a, "user"),
        teamId: flag(a, "team"),
        level: flag(a, "level") ?? "view",
      }),
    ),
});
add({
  name: "project unshare",
  usage: "project unshare <projectId> <grantId>",
  ep: ["projects/[id]/grants/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/projects/${a.pos[0]}/grants?grantId=${a.pos[1]}`)),
});
add({
  name: "member ls",
  usage: "member ls",
  ep: ["members/route.ts"],
  run: async () => {
    const r = (await api("GET", "/api/members")) as { members: { id: string; role: string; user: { email: string } }[] };
    for (const m of r.members) out(`${m.id}\t${m.role}\t${m.user.email}`);
  },
});
add({
  name: "member add",
  usage: "member add <email> [--role <admin|editor|viewer>]",
  ep: ["members/route.ts"],
  run: async (a) => out(await api("POST", "/api/members", { email: a.pos[0], role: flag(a, "role") })),
});
add({
  name: "member role",
  usage: "member role <id> --role <admin|editor|viewer>",
  ep: ["members/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/members/${a.pos[0]}`, { role: flag(a, "role") })),
});
add({
  name: "lesson ls",
  usage: "lesson ls [--project <id>]   (팀 작업규칙·레슨 — 컨텍스트 주입에 포함됨)",
  ep: ["lessons/route.ts"],
  run: async (a) => {
    const pid = flag(a, "project");
    out(await api("GET", `/api/lessons${pid ? `?projectId=${pid}` : ""}`));
  },
});
add({
  name: "lesson add",
  usage: 'lesson add <title> --body "<규칙 본문>" [--project <id>]',
  ep: ["lessons/route.ts"],
  run: async (a) => out(await api("POST", "/api/lessons", { title: a.pos[0], body: flag(a, "body"), projectId: flag(a, "project") })),
});
add({
  name: "lesson rm",
  usage: "lesson rm <id>",
  ep: ["lessons/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/lessons/${a.pos[0]}`)),
});
add({
  name: "route-rule ls",
  usage: "route-rule ls   (cwd→프로젝트 매핑 — 컨텍스트 주입·세션 라우팅)",
  ep: ["route-rules/route.ts"],
  run: async () => out(await api("GET", "/api/route-rules")),
});
add({
  name: "route-rule add",
  usage: "route-rule add <cwdPrefix> [--project <id>] [--priority <n>]",
  ep: ["route-rules/route.ts"],
  run: async (a) => out(await api("POST", "/api/route-rules", { cwdPrefix: a.pos[0], projectId: flag(a, "project"), priority: Number(flag(a, "priority") ?? 0) })),
});
add({
  name: "route-rule rm",
  usage: "route-rule rm <id>",
  ep: ["route-rules/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/route-rules/${a.pos[0]}`)),
});
add({
  name: "inbox ls",
  usage: "inbox ls [--unread]   (내 알림 인박스)",
  ep: ["notifications/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/notifications${bool(a, "unread") ? "?unread=1" : ""}`)) as { notifications: { id: string; type: string; title: string; readAt: string | null; createdAt: string }[]; unread: number };
    out(`미읽음 ${r.unread}건`);
    for (const n of r.notifications) out(`${n.readAt ? " " : "●"} ${n.id}	[${n.type}] ${n.title}`);
  },
});
add({
  name: "inbox read",
  usage: "inbox read [<id>]   (id 없으면 전체 읽음)",
  ep: ["notifications/route.ts", "notifications/[id]/route.ts"],
  run: async (a) => {
    if (a.pos[0]) out(await api("PATCH", `/api/notifications/${a.pos[0]}`, { read: true }));
    else out(await api("POST", "/api/notifications", { readAll: true }));
  },
});
add({
  name: "activity ls",
  usage: "activity ls [--limit <n>] [--type <doc|task|...>]",
  ep: ["activity/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/activity?limit=${flag(a, "limit") ?? 30}${flag(a, "type") ? `&type=${flag(a, "type")}` : ""}`)) as { activities: { actorName: string; verb: string; targetType: string; targetTitle: string; createdAt: string }[] };
    for (const x of r.activities) out(`${x.createdAt.slice(0, 16)}	${x.actorName}	${x.verb}	${x.targetType}	${x.targetTitle}`);
  },
});
add({
  name: "doc comment",
  usage: 'doc comment <pageId> --body "<내용>" [--quote "<본문 문구>"]   (@이름 멘션 시 알림, --quote 는 그 문구에 다는 인라인 코멘트)',
  ep: ["pages/[id]/comments/route.ts"],
  run: async (a) => {
    const quote = flag(a, "quote");
    let anchor: { quote: string; prefix: string; suffix: string } | undefined;
    if (quote) {
      // 앵커의 앞뒤 문맥은 **원문에서** 떠야 한다 — 같은 문구가 여러 번 나올 때
      // 어느 쪽인지 가리는 유일한 단서다.
      const page = (await api("GET", `/api/pages/${a.pos[0]}`)) as { markdown?: string };
      const md = page.markdown ?? "";
      const at = md.indexOf(quote);
      if (at < 0) throw new Error(`본문에서 그 문구를 찾을 수 없습니다: ${quote}`);
      anchor = { quote, prefix: md.slice(Math.max(0, at - 32), at), suffix: md.slice(at + quote.length, at + quote.length + 32) };
    }
    out(await api("POST", `/api/pages/${a.pos[0]}/comments`, { body: flag(a, "body"), anchor }));
  },
});
add({
  name: "doc comment resolve",
  usage: "doc comment resolve <pageId> <commentId> [--undo]   (인라인 코멘트 해결/되돌리기)",
  ep: ["pages/[id]/comments/route.ts"],
  run: async (a) =>
    out(
      await api("PATCH", `/api/pages/${a.pos[0]}/comments?commentId=${a.pos[1]}`, { resolved: !bool(a, "undo") }),
    ),
});
add({
  name: "task block",
  usage: "task block <rowId> --by <선행rowId> [--board <id>]   (의존관계 — '선행 태스크' relation 속성에 추가. --board 없으면 rowId 소속 보드 자동 탐색)",
  ep: ["pages/route.ts", "databases/[id]/route.ts", "databases/[id]/properties/route.ts", "rows/[id]/route.ts"],
  run: async (a) => {
    const rowId = a.pos[0];
    const by = flag(a, "by");
    if (!by) throw new Error("--by <선행rowId> 가 필요합니다.");
    // 기본 보드에 relation 속성을 만들고 남의 행에 그 propId 를 박던 경로를 막는다
    const boardFlag = flag(a, "board");
    const b = boardFlag ? await loadBoard(boardFlag) : await findBoardOfRow(rowId);
    let rel = b.properties.find((pp) => pp.type === "relation" && /선행|blocked|depends/i.test(pp.name));
    if (!rel) {
      // 자기 보드를 가리키는 relation — '선행 태스크' 는 같은 보드의 다른 행이다.
      // (C2 이전엔 config 없이 만들려다 400 으로 죽었다.)
      const created = (await api("POST", `/api/databases/${b.page.id}/properties`, {
        name: "선행 태스크",
        type: "relation",
        config: { targetDatabaseId: b.page.id },
      })) as { property: PropLite };
      rel = created.property;
    }
    const row = b.rows.find((r) => r.id === rowId);
    const cur = Array.isArray(row?.props[rel.id]) ? (row!.props[rel.id] as string[]) : [];
    out(await api("PATCH", `/api/rows/${rowId}`, { props: { [rel.id]: [...new Set([...cur, by])] } }));
  },
});
add({
  name: "project set",
  usage: "project set <id> [--name <n>] [--desc <d>] [--color <c>] [--repo <url>]",
  ep: ["projects/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/projects/${a.pos[0]}`, { name: flag(a, "name"), description: flag(a, "desc"), color: flag(a, "color"), repoUrl: flag(a, "repo") })),
});
add({
  name: "project rm",
  usage: "project rm <id>",
  ep: ["projects/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/projects/${a.pos[0]}`)),
});
add({
  name: "session ls",
  usage: "session ls   (Claude 세션 탐색기)",
  ep: ["sessions/route.ts"],
  run: async () => {
    const r = (await api("GET", "/api/sessions")) as { sessions: { id: string; externalId: string; status: string; cwd: string | null; project: string | null }[] };
    for (const x of r.sessions) out(`${x.id}	${x.status}	${x.project ?? x.cwd ?? "-"}	${x.externalId}`);
  },
});
add({
  name: "session get",
  usage: "session get <id>",
  ep: ["sessions/[id]/route.ts"],
  run: async (a) => out(await api("GET", `/api/sessions/${a.pos[0]}`)),
});
add({
  name: "slack info",
  usage: "slack info   (연결 상태·기본 채널)",
  ep: ["slack/route.ts"],
  run: async () => out(await api("GET", "/api/slack")),
});
add({
  name: "slack channel",
  usage: "slack channel <channelId>   (기본 채널 설정 — env 토큰 모드 지원)",
  ep: ["slack/route.ts"],
  run: async (a) => out(await api("PATCH", "/api/slack", { defaultChannelId: a.pos[0] })),
});
add({
  name: "slack connect",
  usage: "slack connect <botToken>",
  ep: ["slack/connect/route.ts"],
  run: async (a) => out(await api("POST", "/api/slack/connect", { token: a.pos[0] })),
});
add({
  name: "slack test",
  usage: "slack test [--channel <id>]",
  ep: ["slack/test/route.ts"],
  run: async (a) => out(await api("POST", "/api/slack/test", { channel: flag(a, "channel") })),
});
add({
  name: "view ls",
  usage: "view ls <boardId>   (보드의 뷰 목록 — 저장된 정렬·필터 포함)",
  ep: ["databases/[id]/views/route.ts"],
  run: async (a) => out(await api("GET", `/api/databases/${a.pos[0]}/views`)),
});
add({
  name: "view add",
  usage: "view add <boardId> <이름> [--type <table|kanban|gallery|list|calendar|timeline>]",
  ep: ["databases/[id]/views/route.ts"],
  run: async (a) =>
    out(await api("POST", `/api/databases/${a.pos[0]}/views`, { name: a.pos[1], type: flag(a, "type") })),
});
add({
  name: "view set",
  usage: "view set <boardId> <viewId> [--name <n>] [--type <table|kanban|gallery|list|calendar|timeline>] [--sort <propId:asc|desc>] [--group <propId>] [--date <propId>] [--end <propId>]",
  ep: ["databases/[id]/views/[viewId]/route.ts"],
  run: async (a) => {
    const sortFlag = flag(a, "sort");
    let config: Record<string, unknown> | undefined;
    if (sortFlag !== undefined) {
      // "none" 이면 정렬 해제
      const [propId, dir] = sortFlag.split(":");
      config = { sort: sortFlag === "none" || !propId ? null : { propId, dir: dir === "desc" ? "desc" : "asc" } };
    }
    const group = flag(a, "group");
    if (group !== undefined) config = { ...(config ?? {}), groupBy: group === "none" ? null : group };
    // 달력·타임라인이 쓸 날짜 속성(격차 C1). 미지정이면 첫 date 속성을 자동으로 쓴다.
    const dateProp = flag(a, "date");
    if (dateProp !== undefined) config = { ...(config ?? {}), dateProp: dateProp === "none" ? null : dateProp };
    const endProp = flag(a, "end");
    if (endProp !== undefined) config = { ...(config ?? {}), endProp: endProp === "none" ? null : endProp };
    out(
      await api("PATCH", `/api/databases/${a.pos[0]}/views/${a.pos[1]}`, {
        name: flag(a, "name"),
        type: flag(a, "type"),
        config,
      }),
    );
  },
});
add({
  name: "view rm",
  usage: "view rm <boardId> <viewId>   (마지막 뷰는 삭제 불가)",
  ep: ["databases/[id]/views/[viewId]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/databases/${a.pos[0]}/views/${a.pos[1]}`)),
});
add({
  name: "export",
  usage:
    "export [--out <경로>] [--no-attachments]   (워크스페이스 전체를 zip 으로. 기본 ./teamspace-export-<날짜>.zip, 첨부 포함)",
  ep: ["export/route.ts"],
  run: async (a) => {
    const fs = await import("node:fs");
    const qs = bool(a, "no-attachments") ? "?attachments=0" : "";
    const res = await fetch(`${BASE}/api/export${qs}`, { headers: TOKEN ? { "x-ws-token": TOKEN } : {} });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`GET /api/export → ${res.status}: ${msg.slice(0, 200)}`);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = flag(a, "out") ?? `teamspace-export-${stamp}.zip`;
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    out({ file: dest, bytes: fs.statSync(dest).size });
  },
});
add({
  name: "import",
  usage:
    "import <zip경로> [--project <id>] [--dry-run] [--create-projects] [--skip-existing]   (우리 export·노션 export·마크다운 폴더 zip → 문서 + 보드(CSV))",
  ep: ["import/route.ts"],
  run: async (a) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = a.pos[0];
    if (!src) throw new Error("zip 경로가 필요합니다. 예: pnpm ws import ./vault.zip --dry-run");
    const buf = fs.readFileSync(src);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(buf)]), path.basename(src));
    const projectId = flag(a, "project");
    if (projectId) form.set("projectId", projectId);
    if (bool(a, "create-projects")) form.set("createProjects", "1");
    if (bool(a, "skip-existing")) form.set("skipExisting", "1");
    const dryRun = bool(a, "dry-run");
    const res = await fetch(`${BASE}/api/import${dryRun ? "?dryRun=1" : ""}`, {
      method: "POST",
      headers: TOKEN ? { "x-ws-token": TOKEN } : {},
      body: form,
    });
    const payload = (await res.json().catch(() => ({}))) as {
      format?: string;
      counts?: Record<string, number>;
      documents?: { title: string; project: string | null; duplicate?: boolean; pageId?: string | null; attachments?: number }[];
      folders?: { path: string; name: string; projectName: string | null; reusesDoc?: boolean; reusesBoard?: boolean }[];
      boards?: {
        title: string;
        project?: string | null;
        projectName?: string | null;
        rows: number;
        columns: { name: string; type: string; options: number }[];
        linkedDocs?: number;
        duplicate?: boolean;
        skipped?: boolean;
        pageId?: string | null;
      }[];
      attachments?: { path: string; bytes?: number; url?: string }[];
      skipped?: { path: string; reason: string }[];
      warnings?: string[];
      projects?: { name: string; projectId: string | null; willCreate: boolean }[];
    };
    // upload 와 같은 이유로 api() 를 우회한다(multipart) — 실패를 exit 1 로 전파할 것.
    if (!res.ok) throw new Error(`POST /api/import → ${res.status}: ${JSON.stringify(payload)}`);
    out(`형식: ${payload.format}${dryRun ? "  (드라이런 — 아무것도 만들지 않았습니다)" : ""}`);
    for (const w of payload.warnings ?? []) out(`⚠ ${w}`);
    for (const p of payload.projects ?? []) {
      out(`프로젝트  ${p.name} → ${p.projectId ?? (p.willCreate ? "(새로 만듦)" : "미분류")}`);
    }
    for (const d of payload.documents ?? []) {
      out(
        `문서  ${d.title}${d.project ? `  [${d.project}]` : ""}${d.attachments ? `  📎${d.attachments}` : ""}${d.duplicate ? "  (같은 제목 있음)" : ""}${d.pageId ? `  ${d.pageId}` : ""}`,
      );
    }
    for (const f of payload.folders ?? []) {
      const reuse = f.reusesBoard ? "  (같은 이름 보드를 부모로)" : f.reusesDoc ? "  (같은 이름 문서를 부모로)" : "";
      out(`폴더  ${f.projectName ? `[${f.projectName}] ` : ""}${f.path}${reuse}`);
    }
    for (const b of payload.boards ?? []) {
      const proj = b.project ?? b.projectName;
      out(
        `보드  ${b.title}${proj ? `  [${proj}]` : ""}  행 ${b.rows}${b.linkedDocs ? `  본문연결 ${b.linkedDocs}` : ""}${b.duplicate ? "  (같은 제목 있음)" : ""}${b.skipped ? "  (건너뜀)" : ""}${b.pageId ? `  ${b.pageId}` : ""}`,
      );
      out(`      열: ${b.columns.map((c) => `${c.name}(${c.type}${c.options ? `·${c.options}` : ""})`).join(", ")}`);
    }
    for (const a of payload.attachments ?? []) out(`첨부  ${a.path}${a.url ? ` → ${a.url}` : ""}`);
    for (const s of payload.skipped ?? []) out(`건너뜀  ${s.path} — ${s.reason}`);
    out(payload.counts ?? {});
  },
});
add({
  name: "similar",
  usage: "similar <pageId|--q 질의> [--limit n]   (벡터 유사도 — 격차 G2. 신경망 임베딩이 아니라 TF-IDF 코사인)",
  ep: ["search/similar/route.ts"],
  run: async (a) => {
    const q = flag(a, "q");
    const qs = q ? `q=${encodeURIComponent(q)}` : `pageId=${a.pos[0]}`;
    const r = (await api("GET", `/api/search/similar?${qs}&limit=${flag(a, "limit") ?? 5}`)) as {
      mode: string; method: string; indexed: number;
      results: { id: string; title: string; project: string | null; score: number }[];
    };
    out(`${r.mode} · ${r.method} · 색인 ${r.indexed}건`);
    for (const x of r.results) out(`${x.score.toFixed(3)}\t${x.title}${x.project ? `  [${x.project}]` : ""}\t${x.id}`);
    if (r.results.length === 0) out("(비슷한 문서를 찾지 못했습니다)");
  },
});
add({
  name: "presence",
  usage: "presence <pageId>   (지금 이 페이지를 보고 있는 사람 — 격차 D4)",
  ep: ["presence/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/presence?pageId=${a.pos[0]}`)) as {
      viewers: { userId: string; name: string; editing: boolean }[];
    };
    if (r.viewers.length === 0) out("(아무도 없습니다)");
    for (const v of r.viewers) out(`${v.editing ? "✎ 편집 중" : "· 보는 중"}\t${v.name}\t${v.userId}`);
  },
});
add({
  name: "upload",
  usage: "upload <파일경로>   (→ {url, markdown})",
  ep: ["upload/route.ts"],
  run: async (a) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const buf = fs.readFileSync(a.pos[0]);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(buf)]), path.basename(a.pos[0]));
    const res = await fetch(`${BASE}/api/upload`, { method: "POST", headers: TOKEN ? { "x-ws-token": TOKEN } : {}, body: form });
    // api() 헬퍼를 우회하는 유일한 명령이라 실패해도 exit 0 이었다 — 다른 모든 명령은
    // res.ok 검사 후 throw → exit 1 이다. 스크립트가 업로드 실패를 못 알아챘다(D22).
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`POST /api/upload → ${res.status}: ${JSON.stringify(payload)}`);
    out(payload);
  },
});
add({
  name: "upload get",
  usage: "upload get <url|<ws>/<파일명>> [--out <경로>]   (첨부 내려받기 — 서빙 라우트 확인용)",
  ep: ["uploads/[...path]/route.ts"],
  run: async (a) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const arg = a.pos[0];
    if (!arg) throw new Error("URL 또는 <워크스페이스id>/<파일명> 이 필요합니다.");
    // /uploads/<ws>/<f> 든 /api/uploads/<ws>/<f> 든 절대 URL 이든 같은 자리로 보낸다.
    const rel = arg.replace(/^https?:\/\/[^/]+/, "").replace(/^\/?(api\/)?uploads\//, "");
    const res = await fetch(`${BASE}/api/uploads/${rel}`, { headers: TOKEN ? { "x-ws-token": TOKEN } : {} });
    if (!res.ok) throw new Error(`GET /api/uploads/${rel} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = flag(a, "out");
    if (dest) {
      fs.writeFileSync(dest, buf);
      out({ file: dest, bytes: buf.length, type: res.headers.get("content-type") });
    } else {
      out({
        bytes: buf.length,
        type: res.headers.get("content-type"),
        disposition: res.headers.get("content-disposition"),
        cache: res.headers.get("cache-control"),
        name: path.basename(rel),
      });
    }
  },
});
add({
  name: "proposal ls",
  usage: "proposal ls [--status pending|approved|rejected]",
  ep: ["proposals/route.ts"],
  run: async (a) => {
    const st = flag(a, "status");
    const r = (await api("GET", `/api/proposals${st ? `?status=${st}` : ""}`)) as { proposals: { id: string; kind: string; status: string; title: string; proposedByName: string }[] };
    for (const x of r.proposals) out(`${x.id}	${x.status}	[${x.kind}] ${x.title} — ${x.proposedByName}`);
  },
});
add({
  name: "proposal add",
  usage: 'proposal add <title> --kind <lesson|decision> --body "<본문>" [--project <id>]   (팀 지식 승격 제안 — admin 승인 후 등록)',
  ep: ["proposals/route.ts"],
  run: async (a) => out(await api("POST", "/api/proposals", { title: a.pos[0], kind: flag(a, "kind"), body: flag(a, "body"), projectId: flag(a, "project") })),
});
add({
  name: "proposal approve",
  usage: "proposal approve <id> [--note <메모>]   (admin)",
  ep: ["proposals/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/proposals/${a.pos[0]}`, { action: "approve", note: flag(a, "note") })),
});
add({
  name: "proposal reject",
  usage: "proposal reject <id> [--note <사유>]   (admin)",
  ep: ["proposals/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/proposals/${a.pos[0]}`, { action: "reject", note: flag(a, "note") })),
});
add({
  name: "token ls",
  usage: "token ls   (에이전트 토큰 목록 — admin)",
  ep: ["agent-tokens/route.ts"],
  run: async () => out(await api("GET", "/api/agent-tokens")),
});
add({
  name: "token add",
  usage: "token add <name> [--role <admin|editor|viewer>]   (발급 — 원문은 이 1회만 노출)",
  ep: ["agent-tokens/route.ts"],
  run: async (a) => out(await api("POST", "/api/agent-tokens", { name: a.pos[0], role: flag(a, "role") })),
});
add({
  name: "token revoke",
  usage: "token revoke <id>   (회수 — 에이전트 멤버십도 removed 처리)",
  ep: ["agent-tokens/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/agent-tokens/${a.pos[0]}`)),
});
add({
  name: "member rm",
  usage: "member rm <id>",
  ep: ["members/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/members/${a.pos[0]}`)),
});
add({
  name: "member team",
  usage: "member team <memberId> --team <teamId>   (빈 값/생략 시 미배정)",
  ep: ["members/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/members/${a.pos[0]}`, { teamId: flag(a, "team") ?? null })),
});

// 팀
add({
  name: "team ls",
  usage: "team ls",
  ep: ["teams/route.ts"],
  run: async () => {
    const r = (await api("GET", "/api/teams")) as { teams: { id: string; name: string; color: string; memberCount: number }[] };
    for (const t of r.teams) out(`${t.id}\t${t.color}\t${t.memberCount}명\t${t.name}`);
  },
});
add({
  name: "team add",
  usage: "team add <name> [--color <blue|orange|purple|green|red|gray>]",
  ep: ["teams/route.ts"],
  run: async (a) => out(await api("POST", "/api/teams", { name: a.pos[0], color: flag(a, "color") })),
});
add({
  name: "team rename",
  usage: "team rename <id> <name> [--color <c>]",
  ep: ["teams/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/teams/${a.pos[0]}`, { name: a.pos[1], color: flag(a, "color") })),
});
add({
  name: "team rm",
  usage: "team rm <id>",
  ep: ["teams/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/teams/${a.pos[0]}`)),
});

add({
  name: "ws info",
  usage: "ws info   (워크스페이스 정보/내 역할)",
  ep: ["workspace/route.ts"],
  run: async () => out(await api("GET", "/api/workspace")),
});
add({
  name: "ws rename",
  usage: "ws rename <name>   (admin)",
  ep: ["workspace/route.ts"],
  run: async (a) => out(await api("PATCH", "/api/workspace", { name: a.pos[0] })),
});

// 멀티 워크스페이스 (내가 속한 워크스페이스 전환·생성)
add({
  name: "workspace ls",
  usage: "workspace ls   (내가 속한 워크스페이스 목록 · 현재 표시)",
  ep: ["workspaces/route.ts"],
  run: async () => {
    const r = (await api("GET", "/api/workspaces")) as { workspaces: { id: string; name: string; role: string; memberCount: number; current: boolean }[] };
    for (const w of r.workspaces) out(`${w.current ? "*" : " "}\t${w.id}\t${w.role}\t${w.memberCount}명\t${w.name}`);
  },
});
add({
  name: "workspace new",
  usage: "workspace new <name>   (새 워크스페이스 생성 후 전환)",
  ep: ["workspaces/route.ts"],
  run: async (a) => out(await api("POST", "/api/workspaces", { name: a.pos[0] })),
});
add({
  name: "workspace switch",
  usage: "workspace switch <workspaceId>   (활성 워크스페이스 전환 · ws_active 쿠키)",
  ep: ["workspaces/switch/route.ts"],
  run: async (a) => out(await api("POST", "/api/workspaces/switch", { workspaceId: a.pos[0] })),
});

// 유틸 (검색 / 린트 / 그래프)
add({
  name: "search",
  usage: 'search <q> [--project <id|__none__>] [--kind <doc,board,decision>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--limit <n>]',
  ep: ["search/route.ts"],
  run: async (a) => {
    const p = new URLSearchParams({ q: a.pos[0] ?? "" });
    for (const [flagName, key] of [["project", "projectId"], ["kind", "kind"], ["from", "from"], ["to", "to"], ["limit", "limit"]] as const) {
      const v = flag(a, flagName);
      if (v !== undefined) p.set(key, v);
    }
    out(await api("GET", `/api/search?${p.toString()}`));
  },
});
add({
  name: "ask",
  usage: 'ask <질문>   (vault Q&A — 문서·결정 근거로 답변, LLM 키 있으면 합성)',
  ep: ["ask/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/ask?q=${encodeURIComponent(a.pos[0] ?? "")}`)) as {
      answer: string; mode: string; sources: { title: string; kind: string; heading: string | null }[];
    };
    out(`[${r.mode}]\n${r.answer}`);
    if (r.sources.length) out("\n출처:");
    for (const s of r.sources) out(`  · (${s.kind}) ${s.title}${s.heading ? ` › ${s.heading}` : ""}`);
  },
});
add({
  name: "concept",
  usage: 'concept <검색어>   (개념 검색 — LLM 질의확장으로 연관 문서까지 회수)',
  ep: ["search/concept/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/search/concept?q=${encodeURIComponent(a.pos[0] ?? "")}`)) as {
      mode: string; expanded: string[]; results: { title: string; kind: string; heading: string | null }[];
    };
    out(`[${r.mode}] 확장어: ${r.expanded.join(", ") || "(없음)"}`);
    for (const s of r.results) out(`  · (${s.kind}) ${s.title}${s.heading ? ` › ${s.heading}` : ""}`);
  },
});
add({
  name: "clip",
  usage: 'clip <url> --text "<본문>" [--title <t>]   (웹 클립 → 요약·자동분류 후 문서 저장; LLM)',
  ep: ["clip/route.ts"],
  run: async (a) => {
    const r = (await api("POST", "/api/clip", { url: a.pos[0], text: flag(a, "text"), title: flag(a, "title") })) as {
      ok: boolean; pageId: string; projectName: string | null; summary: string; mode: string;
    };
    out(`[${r.mode}] 저장됨 (${r.pageId}) · 프로젝트: ${r.projectName ?? "미분류"}`);
    if (r.summary) out(`요약: ${r.summary}`);
  },
});
add({
  name: "provenance",
  usage: "provenance <pageId>   (문서 주장을 추출/추론/모호로 분류; LLM)",
  ep: ["provenance/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("pageId가 필요합니다: ws provenance <pageId>");
    const r = (await api("POST", "/api/provenance", { pageId: a.pos[0] })) as {
      ok: boolean; error?: string; claims?: { claim: string; tag: string; note: string }[]; counts?: Record<string, number>;
    };
    if (!r.ok) return out(`(분석 불가: ${r.error})`);
    out(`추출 ${r.counts?.["추출"] ?? 0} · 추론 ${r.counts?.["추론"] ?? 0} · 모호 ${r.counts?.["모호"] ?? 0}`);
    for (const c of r.claims ?? []) out(`[${c.tag}]\t${c.claim}${c.note ? `  (${c.note})` : ""}`);
  },
});
add({
  name: "lint",
  usage: "lint   (깨진 위키링크·고아 문서)",
  ep: ["lint/route.ts"],
  run: async () => out(await api("GET", "/api/lint")),
});
add({
  name: "graph",
  usage: "graph   (위키 그래프)",
  ep: ["graph/route.ts"],
  run: async () => out(await api("GET", "/api/graph")),
});
add({
  name: "context",
  usage: "context   (워크스페이스를 Claude가 읽는 Markdown 스냅샷으로 출력)",
  ep: ["context/route.ts"],
  run: async () => out(await api("GET", "/api/context?format=md")),
});
add({
  name: "slack log",
  usage: "slack log [--kind <manual|approval|reminder|test>]",
  ep: ["slack/log/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/slack/log?kind=${flag(a, "kind") ?? "all"}`)) as { logs: { channel: string; kind: string; state: string; text: string }[]; sentToday: number; total: number; failed: number };
    out(`오늘 ${r.sentToday} · 전체 ${r.total} · 실패 ${r.failed}`);
    for (const l of r.logs) out(`${l.state === "failed" ? "✗" : "✓"}\t${l.channel}\t${l.kind}\t${l.text}`);
  },
});

add({
  name: "slack channels",
  usage: "slack channels   (공개 채널 목록 — channels:read 필요)",
  ep: ["slack/channels/route.ts"],
  run: async () => {
    const r = (await api("GET", "/api/slack/channels")) as { ok: boolean; channels?: { id: string; name: string }[]; error?: string };
    if (!r.ok) return out(`(채널 조회 불가: ${r.error})`);
    for (const c of r.channels ?? []) out(`${c.id}\t#${c.name}`);
  },
});

// 자동 알림 규칙
add({
  name: "notif-rule ls",
  usage: "notif-rule ls",
  ep: ["notif-rules/route.ts"],
  run: async () => {
    const r = (await api("GET", "/api/notif-rules")) as { rules: { id: string; event: string; targetId: string; enabled: boolean; projectId: string | null }[] };
    for (const x of r.rules) out(`${x.id}\t${x.enabled ? "on" : "off"}\t${x.event}\t${x.targetId}\t${x.projectId ?? "전체(global)"}`);
  },
});
add({
  name: "notif-rule add",
  usage: "notif-rule add <event(task_created|task_status|task_assigned|task_due|comment_added|doc_saved)> <channel> [--project <projectId>]",
  ep: ["notif-rules/route.ts"],
  run: async (a) => out(await api("POST", "/api/notif-rules", { event: a.pos[0], targetId: a.pos[1], projectId: flag(a, "project") })),
});
add({
  name: "notif-rule toggle",
  usage: "notif-rule toggle <id> [--off]",
  ep: ["notif-rules/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/notif-rules/${a.pos[0]}`, { enabled: !bool(a, "off") })),
});
add({
  name: "notif-rule rm",
  usage: "notif-rule rm <id>",
  ep: ["notif-rules/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/notif-rules/${a.pos[0]}`)),
});

// 예약 작업 디스패치(워커/cron 수동 트리거)
add({
  name: "tick",
  usage: "tick [--preview]   (만기 예약 알림 1회 디스패치 · --preview 는 대기 건수만)",
  ep: ["cron/tick/route.ts"],
  run: async (a) => out(await api(bool(a, "preview") ? "GET" : "POST", "/api/cron/tick")),
});

// 비동기 LLM 잡 (디버그용 최소 명령 — 실처리는 워커 dispatchLlmJobs, 결과는 callbackUrl 로 POST)
add({
  name: "llm classify",
  usage: 'llm classify --body <텍스트> --callback <url>   (kind=feedback_classify 잡 접수 → 202 jobId)',
  ep: ["llm/classify/route.ts"],
  run: async (a) => {
    const body = flag(a, "body");
    if (!body) throw new Error("--body 가 필요합니다: ws llm classify --body <텍스트> --callback <url>");
    const callback = flag(a, "callback");
    if (!callback) throw new Error("--callback 이 필요합니다(결과가 이 URL로 POST됨): ws llm classify --body <텍스트> --callback <url>");
    out(
      await api("POST", "/api/llm/classify", {
        kind: "feedback_classify",
        payload: { ref: "cli", body, agendas: [] },
        callbackUrl: callback,
      }),
    );
  },
});

// ── 디스패치 ─────────────────────────────────────────────────────────────────
const REGISTRY = new Map(COMMANDS.map((c) => [c.name, c]));

function help(): void {
  console.log("ws — TeamSpace 워크스페이스 CLI\n");
  console.log("Usage: pnpm ws <command> [args] [--flags]\n");
  let group = "";
  for (const c of COMMANDS) {
    const g = c.name.split(" ")[0];
    if (g !== group) {
      console.log("");
      group = g;
    }
    console.log(`  ${c.usage}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") return help();
  const { pos, flags } = parse(argv);

  // 긴 접두사부터 매칭(3→2→1단어) — "task check add" 같은 3단어 명령 지원 (감사 task-1)
  let cmd: Cmd | undefined;
  let rest: string[] = [];
  for (let n = Math.min(3, pos.length); n >= 1; n--) {
    const found = REGISTRY.get(pos.slice(0, n).join(" "));
    if (found) {
      cmd = found;
      rest = pos.slice(n);
      break;
    }
  }
  if (!cmd) {
    console.error(`알 수 없는 명령: ${pos.join(" ")}\n'pnpm ws help' 로 목록을 보세요.`);
    process.exit(1);
  }
  await cmd.run({ pos: rest, flags });
}

// 패리티 테스트(ws.test.ts)에서 명령↔라우트 검증에 사용.
export const MANIFEST = COMMANDS.map((c) => ({ name: c.name, ep: c.ep }));

if (!process.env.VITEST) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
