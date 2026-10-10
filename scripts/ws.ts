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
import { defaultPrefix, parseReviewTables, planReviewImport, reviewTaskBody } from "../lib/reviewImport";
import { findAssigneeProp, findDateProp, findStatusProp, optionIdByName } from "../lib/taskProps"; // .env 자동 로드 — WS_TOKEN/AUTH_CLI_TOKEN 인증 (감사 agent-1)
import { TEMPLATES } from "../lib/docTemplates";
import { draftFromCommits, gitRangeArg, parseGitLog, pickAnchorSource } from "../lib/changelogDraft";
import { fetchWithRetry } from "../lib/retryAfter";
import { clampLimitArg } from "../lib/taskFilter";
import { pickRouteRule, resolveDraftProject } from "../lib/cwdProject";
import { extractRehearsalBlock } from "../lib/rehearsalRecord";
import { formatTokens } from "../lib/opsFormat";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { lockExtend, lockInstallHook, lockLs, lockPath, lockRelease, lockTake, sessionsLive } from "./wsLock";
import { envDrift, envGroups, envImport, envLs, envPull, envPush, envTargetAdd, envTargetLs, envTargetRm, resolveProject } from "./wsEnv";

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
async function api(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (TOKEN) headers["x-ws-token"] = TOKEN;
  // timeoutMs 는 응답 본문까지 포함한다(신호가 res.text() 도 끊는다). 기본은 무제한(종전 동작).
  const timedOut = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  let res: Response;
  let signal: AbortSignal | undefined;
  try {
    ({ res, signal } = await fetchWithRetry(
      (sig) =>
        fetch(`${BASE}${path}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: sig,
        }),
      {
        timeoutMs: opts.timeoutMs,
        onRetry: (wait) => console.error(`429 — ${Math.ceil(wait / 1000)}s 뒤 재시도`),
      },
    ));
  } catch (err) {
    if (signal && timedOut(err)) throw new Error(`${method} ${path} 시간 초과(${opts.timeoutMs}ms)`);
    throw new Error(
      `${BASE} 에 연결할 수 없습니다. dev 서버를 먼저 띄우세요: pnpm exec next dev -p 3002`,
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (signal && timedOut(err)) throw new Error(`${method} ${path} 시간 초과(${opts.timeoutMs}ms)`);
    throw err;
  }
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
    throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${msg}`), { status: res.status, body: data });
  }
  return data;
}

/** api() 와 같지만 실패해도 던지지 않고 본문을 돌려준다 — 에러 응답에 담긴 보고(예: dropped)를 보여줄 때. */
async function apiRaw(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (TOKEN) headers["x-ws-token"] = TOKEN;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`${BASE} 에 연결할 수 없습니다. dev 서버를 먼저 띄우세요: pnpm exec next dev -p 3002`);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
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
  usage: "task ls [--board <id>] [--assignee <이름|me>] [--all] [--limit <n>]   (기본 열린 것 50건)",
  ep: ["tasks/route.ts"],
  run: async (a) => {
    const q = new URLSearchParams();
    const b = flag(a, "board");
    const asgn = flag(a, "assignee");
    if (b) q.set("board", b);
    if (asgn) q.set("assignee", asgn);
    if (bool(a, "all")) q.set("status", "all");
    const lim = flag(a, "limit");
    if (lim) q.set("limit", String(clampLimitArg(lim)));
    const qs = q.toString();
    const r = (await api("GET", `/api/tasks${qs ? `?${qs}` : ""}`)) as {
      total: number;
      shown: number;
      tasks: { id: string; title: string; status: string | null; due: string | null; assignee: string | null }[];
    };
    for (const t of r.tasks) out(`${t.id}\t${t.status ?? "-"}\t${t.assignee ?? "-"}\t${t.due ?? "-"}\t${t.title}`);
    out(`총 ${r.total}건 중 ${r.shown}건`);
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
  name: "review import",
  usage:
    'review import <docId> [--prefix "[리뷰 10/08]"] [--board <id>] [--dry-run]   (리뷰 문서의 `## N.` 표 중 첫 열이 B1·U3·A-5 같은 코드인 행을 보드 태스크로 등록. 이미 `<접두어> <코드>` 제목이 있으면 건너뜀. 심각도→우선순위, 본문은 태스크 댓글)',
  ep: ["pages/[id]/route.ts", "pages/route.ts", "databases/[id]/route.ts", "databases/[id]/rows/route.ts", "rows/[id]/comments/route.ts"],
  run: async (a) => {
    const docId = a.pos[0];
    if (!docId) throw new Error("docId가 필요합니다: ws review import <docId> [--prefix ...] [--dry-run]");
    const doc = (await api("GET", `/api/pages/${docId}`)) as { page?: { title?: string }; markdown?: string };
    const rows = parseReviewTables(doc.markdown ?? "");
    if (!rows.length) throw new Error("코드 행(B1·U3·A-5 …)이 있는 표를 찾지 못했습니다.");
    const prefix = flag(a, "prefix") ?? defaultPrefix(doc.page?.title ?? "", new Date());
    const dry = bool(a, "dry-run");
    const b = await loadBoard(flag(a, "board"));
    // 중복 판정은 보드 행 제목으로 한다 — /api/search 는 문서·결정만 색인하고 보드 행은 안 넣는다.
    const titleProp = prop(b, /이름|name|title/i, "text") ?? b.properties.find((p) => p.type === "text");
    const titles = b.rows.map((r) => (titleProp ? r.props[titleProp.id] : undefined)).filter((t): t is string => typeof t === "string");
    // 심각도 → 우선순위 옵션 이름(기본 보드는 낮음/보통/높음 — '중간' 은 '보통' 으로).
    const prioName: Record<string, string> = { 높음: "높음", 중간: "중간|보통", 낮음: "낮음" };
    const plan = planReviewImport(rows, titles, prefix);
    // 기본 보드는 "/api/pages 의 첫 database 페이지"라 어디에 쓰는지 먼저 보여 준다(dry-run 포함).
    out(`대상 보드: ${b.page.title} · ${b.page.id}`);
    const prioProp = prop(b, /우선순위|priority/i, "select");
    // 셀 원문은 정규식 메타문자(높음(P1)·C++)를 담을 수 있다 — 매핑에 없는 값은 이스케이프해 정확 일치로.
    const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prioPattern = (sev: string) => prioName[sev] ?? `^${escapeRe(sev)}$`;
    const warnedSev = new Set<string>();
    let created = 0;
    let failed = 0;
    for (const { row: r, title } of plan.create) {
      const pid = r.severity && prioProp ? optionId(prioProp, prioPattern(r.severity)) : undefined;
      if (r.severity && prioProp && !pid && !warnedSev.has(r.severity)) {
        warnedSev.add(r.severity);
        out(`⚠ 우선순위 미매칭: '${r.severity}' — 우선순위 없이 등록`);
      }
      if (dry) {
        out(`[dry-run] ${title}${r.severity ? `  (우선순위 ${r.severity})` : ""}`);
        created++;
        continue;
      }
      // 행마다 실패를 격리한다 — 한 행의 생성·댓글 실패가 나머지 행 처리를 막지 않게.
      let rowId: string | undefined;
      try {
        const props = buildProps(b, { pos: [], flags: {} }, title);
        if (prioProp && pid) props[prioProp.id] = pid;
        const res = (await api("POST", `/api/databases/${b.page.id}/rows`, { props })) as { row?: { id: string } };
        rowId = res.row?.id;
        if (rowId) await api("POST", `/api/rows/${rowId}/comments`, { body: reviewTaskBody(docId, r) });
        created++;
        out(`${rowId ?? "-"}\t${title}`);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        // 행은 만들어졌는데 댓글만 실패하면, 재실행 시 제목 중복으로 건너뛰니 본문을 손으로 채워야 한다.
        out(rowId ? `⚠ 댓글 실패 ${rowId}\t${title} — ${msg}` : `⚠ 생성 실패\t${title} — ${msg}`);
      }
    }
    const skipped = plan.skipped.length;
    out(`생성 ${created} · 건너뜀 ${skipped} · 실패 ${failed}${dry ? "  (dry-run — 아무것도 쓰지 않음)" : ""}`);
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
  usage: "task mine [--board <id>] [--limit <n>] [--all]   (내 담당 태스크 — assignee=me, 기본 열린 것 50건. --all=한도 없이 전부(열린 것만), --limit 1..200)",
  ep: ["tasks/route.ts"],
  run: async (a) => {
    const q = new URLSearchParams({ assignee: "me" });
    const b = flag(a, "board");
    if (b) q.set("board", b);
    // --all = 페이징 없이 전부(라우트의 limit=all 옵트인). --limit 는 1..200 으로 자른다.
    if (bool(a, "all")) q.set("limit", "all");
    else if (flag(a, "limit")) q.set("limit", String(clampLimitArg(flag(a, "limit"))));
    const r = (await api("GET", `/api/tasks?${q}`)) as {
      total: number;
      shown: number;
      tasks: { id: string; title: string; status: string | null; due: string | null; assignee: string | null }[];
    };
    for (const t of r.tasks) out(`${t.id}\t${t.status ?? "-"}\t${t.assignee ?? "-"}\t${t.due ?? "-"}\t${t.title}`);
    out(`총 ${r.total}건 (표시 ${r.shown})`);
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
  name: "task transfer",
  usage:
    "task transfer <rowId> --to <boardId> [--dry-run] [--create-options] [--expect <updatedAt>]   (행을 다른 보드로 이동 — 이름·타입 매핑, 먼저 --dry-run 권장)",
  ep: ["rows/[id]/move/route.ts"],
  run: async (a) => {
    const rowId = a.pos[0];
    const to = flag(a, "to");
    if (!rowId || !to)
      throw new Error("usage: ws task transfer <rowId> --to <boardId> [--dry-run] [--create-options] [--expect <updatedAt>]");
    const dryRun = bool(a, "dry-run");
    const expect = flag(a, "expect");
    const r = await apiRaw("POST", `/api/rows/${rowId}/move`, {
      targetDatabaseId: to,
      ...(dryRun ? { dryRun: true } : {}),
      ...(bool(a, "create-options") ? { createMissingOptions: true } : {}),
      ...(expect ? { expectedUpdatedAt: expect } : {}),
    });
    const d = (r.data ?? {}) as {
      error?: string;
      childCount?: number;
      row?: { id: string; databasePageId: string };
      mapped?: { name: string; type: string; to?: string }[];
      dropped?: { name: string; type: string; reason: string; value: unknown }[];
      createdOptions?: { property: string; option: { id: string; name: string } }[];
      referencedBy?: number;
    };
    if (!r.ok) {
      console.error(`POST /api/rows/${rowId}/move → ${r.status}: ${d.error ?? JSON.stringify(r.data)}`);
      if (d.childCount !== undefined) console.error(`  하위 항목 ${d.childCount}개`);
      for (const x of d.dropped ?? []) console.error(`  - 버림 ${x.name}(${x.type}): ${x.reason} ${JSON.stringify(x.value)}`);
      process.exit(1);
    }
    out(dryRun ? `[드라이런] 아무것도 바뀌지 않았습니다 — 대상 보드 ${to}` : `이동 완료: ${d.row?.id} → 보드 ${d.row?.databasePageId}`);
    out(`매핑 ${d.mapped?.length ?? 0}개: ${(d.mapped ?? []).map((m) => (m.to ? `${m.name}→${m.to}` : m.name)).join(", ") || "-"}`);
    out(`버림 ${d.dropped?.length ?? 0}개`);
    for (const x of d.dropped ?? []) out(`  - ${x.name}(${x.type}): ${x.reason} ${JSON.stringify(x.value)}`);
    if (d.createdOptions?.length) {
      out(`${dryRun ? "만들 옵션" : "만든 옵션"} ${d.createdOptions.length}개: ${d.createdOptions.map((c) => `${c.property}='${c.option.name}'`).join(", ")}`);
    }
    if (d.referencedBy) out(`주의: 다른 행 ${d.referencedBy}개가 이 행을 relation 으로 가리킵니다 — 이동 후 그 연결은 보드를 넘는 링크가 됩니다.`);
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
  usage: "doc ls [--archived]   (--archived=보관함 문서만; 기본은 보관 제외)",
  ep: ["pages/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/pages${bool(a, "archived") ? "?archived=1" : ""}`)) as { pages: { id: string; title: string; kind: string }[] };
    for (const p of r.pages.filter((x) => x.kind !== "database")) out(`${p.id}\t${p.title}`);
  },
});
add({
  name: "doc archive",
  usage: "doc archive <id>   (보관 — 사이드바·목록·검색에서 빠짐. 되돌리기: doc unarchive)",
  ep: ["pages/archive/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("usage: ws doc archive <id>");
    out(await api("POST", "/api/pages/archive", { id: a.pos[0], archived: true }));
  },
});
add({
  name: "doc unarchive",
  usage: "doc unarchive <id>   (보관 해제)",
  ep: ["pages/archive/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("usage: ws doc unarchive <id>");
    out(await api("POST", "/api/pages/archive", { id: a.pos[0], archived: false }));
  },
});
add({
  name: "doc new",
  usage: 'doc new <title> [--project <id>] [--parent <id>] [--folder "<이름>"] [--type design|plan|brief|report|handoff|task_note|other] [--template design|plan|report|handoff] [--unique]   (--unique=같은 프로젝트에 같은 제목 문서가 있으면 409 로 거절. 없이도 중복이면 경고를 stderr 에 출력)',
  ep: ["pages/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("제목이 필요합니다: ws doc new <title>");
    let res: unknown;
    try {
      res = await api("POST", "/api/pages", { title: a.pos[0], kind: "doc", projectId: flag(a, "project"), parentId: flag(a, "parent"), folder: flag(a, "folder"), docType: flag(a, "type"), template: flag(a, "template"), ifUnique: bool(a, "unique") || undefined });
    } catch (e) {
      // --unique 409: 어떤 문서와 겹치는지 id·제목을 stderr 에 보여 준 뒤 그대로 다시 던진다(비-0 종료).
      const err = e as { status?: number; body?: { duplicates?: { id: string; title: string }[] } };
      if (err.status === 409) for (const d of err.body?.duplicates ?? []) console.error(`중복: ${d.id} ${d.title}`);
      throw e;
    }
    out(res);
    const warn = (res as { warnings?: { code: string; pages: { id: string; title: string }[] }[] } | undefined)?.warnings?.find((w) => w.code === "duplicate_title");
    if (warn?.pages.length) console.error(`⚠ 같은 제목 문서 ${warn.pages.length}건: ${warn.pages.map((p) => `${p.id} ${p.title}`).join(", ")}`);
  },
});
add({
  name: "doc templates",
  usage: "doc templates   (doc new --template 에 쓸 수 있는 템플릿 이름·라벨·docType)",
  ep: ["pages/route.ts"],
  run: async () => {
    for (const [name, t] of Object.entries(TEMPLATES)) out(`${name}\t${t.label}\t${t.docType}`);
  },
});
add({
  name: "doc organize",
  usage: "doc organize [--apply [--limit <n>]] [--undo <기록docId>] [--project <id>] [--base <url>]   (뿌리 문서를 트랙 폴더로 이관. 기본=드라이런, 기록 문서 1건 생성. --limit=리허설로 분류된 앞 n건만 적용)",
  ep: ["pages/route.ts", "pages/[id]/route.ts"],
  run: async (a) => {
    const args: string[] = [];
    if (a.flags.limit !== undefined && !flag(a, "limit")) throw new Error("--limit 에는 양의 정수가 필요합니다");
    if (a.flags.undo !== undefined && !flag(a, "undo")) throw new Error("--undo 에는 기록 doc id 가 필요합니다");
    if (bool(a, "apply")) args.push("--apply");
    for (const f of ["undo", "project", "base", "limit"]) {
      const v = flag(a, f);
      if (v) args.push(`--${f}`, v);
    }
    (await import("node:child_process")).execFileSync("pnpm", ["exec", "tsx", "scripts/organize-docs.ts", ...args], { stdio: "inherit" });
  },
});
add({
  name: "doc type",
  usage: "doc type <id> <design|plan|brief|report|handoff|task_note|other|none>",
  ep: ["pages/[id]/route.ts"],
  run: async (a) => {
    if (!a.pos[0] || !a.pos[1]) throw new Error("usage: ws doc type <id> <type>");
    out(await api("PATCH", `/api/pages/${a.pos[0]}`, { docType: a.pos[1] === "none" ? null : a.pos[1] }));
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

// 즐겨찾기·최근 열람 (사람별 — 호출한 토큰의 사용자 기준)
add({
  name: "fav ls",
  usage: "fav ls [--archived]   (내 즐겨찾기 목록 — 볼 수 없는 페이지 제외, 보관 문서는 --archived 일 때만)",
  ep: ["favorites/route.ts"],
  run: async (a) => out(await api("GET", `/api/favorites${bool(a, "archived") ? "?archived=1" : ""}`)),
});
add({
  name: "fav add",
  usage: "fav add <pageId>",
  ep: ["favorites/route.ts"],
  run: async (a) => out(await api("POST", "/api/favorites", { pageId: a.pos[0] })),
});
add({
  name: "fav rm",
  usage: "fav rm <pageId>",
  ep: ["favorites/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/favorites?pageId=${encodeURIComponent(a.pos[0])}`)),
});
add({
  name: "fav order",
  usage: "fav order <pageId> [<pageId> ...]   (나열한 순서대로 재배치)",
  ep: ["favorites/route.ts"],
  run: async (a) => out(await api("PATCH", "/api/favorites", { order: a.pos })),
});
add({
  name: "visit ls",
  usage: "visit ls [--limit 8] [--archived]   (최근 열람, 최대 20 — 보관 문서는 --archived 일 때만)",
  ep: ["visits/route.ts"],
  run: async (a) =>
    out(await api("GET", `/api/visits?limit=${encodeURIComponent(flag(a, "limit") ?? "8")}${bool(a, "archived") ? "&archived=1" : ""}`)),
});

// 프로젝트
add({
  name: "project ls",
  usage: "project ls [--archived [all]]   (기본=활성만 · --archived=보관함만 · --archived all=둘 다)",
  ep: ["projects/route.ts"],
  run: async (a) => {
    const f = flag(a, "archived");
    const q = f === "all" ? "?archived=all" : bool(a, "archived") || f !== undefined ? "?archived=1" : "";
    listItems(await api("GET", `/api/projects${q}`), "projects");
  },
});
add({
  name: "project archive",
  usage: "project archive <id>   (보관 — 선택 목록·GET /api/projects 기본에서 빠짐. 사이드바엔 '(보관)' 으로 남음)",
  ep: ["projects/[id]/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("usage: ws project archive <id>");
    out(await api("PATCH", `/api/projects/${a.pos[0]}`, { archived: true }));
  },
});
add({
  name: "project unarchive",
  usage: "project unarchive <id>   (보관 해제)",
  ep: ["projects/[id]/route.ts"],
  run: async (a) => {
    if (!a.pos[0]) throw new Error("usage: ws project unarchive <id>");
    out(await api("PATCH", `/api/projects/${a.pos[0]}`, { archived: false }));
  },
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
  projParam?: string; // 필터 쿼리 키(기본 projectId — changelog 는 project)
}
const RESOURCES: ResDef[] = [
  { group: "decision", path: "decisions", listKey: "decisions", proj: true, fields: [["title", "title"], ["context", "context"], ["decision", "decision"], ["status", "status"], ["project", "projectId"]] },
  { group: "risk", path: "risks", listKey: "risks", proj: true, fields: [["title", "title"], ["desc", "description"], ["severity", "severity"], ["status", "status"], ["project", "projectId"]] },
  { group: "qa", path: "qa", listKey: "scenarios", proj: true, fields: [["title", "title"], ["steps", "steps"], ["expected", "expected"], ["status", "status"], ["project", "projectId"]] },
  { group: "glossary", path: "glossary", listKey: "terms", fields: [["term", "term"], ["def", "definition"]] },
  { group: "changelog", path: "changelog", listKey: "entries", proj: true, projParam: "project", fields: [["title", "title"], ["version", "version"], ["body", "body"], ["project", "projectId"]] },
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
    usage: `${r.group} ls${r.proj ? " [--project <id>]" : ""}${r.projParam ? "   (--project none = 공용 항목만)" : ""}`,
    ep: [`${r.path}/route.ts`],
    run: async (a) => {
      const proj = r.proj ? flag(a, "project") : undefined;
      listItems(await api("GET", `/api/${r.path}${proj ? `?${r.projParam ?? "projectId"}=${encodeURIComponent(proj)}` : ""}`), r.listKey);
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
  name: "changelog draft",
  usage: "changelog draft [--since <ref|YYYY-MM-DD>] [--project <id|auto|none>] [--dry-run]   (--project 기본 auto = cwd→프로젝트 라우트 규칙, 매핑 없으면 공용 + 경고. 앵커·버전은 같은 프로젝트 항목만 보되, 프로젝트 항목이 0건이면 공용 항목으로 폴백(버전은 합집합). --dry-run 은 앵커 출처 표시. since 이후 feat/fix/perf 커밋 → 변경 이력 1건. 기본 since=마지막 자동 초안(버전 YYYY.MM.DD·제목 '배포 …')의 releasedAt, 없으면 7일 전. 불릿 50개 상한, 같은 버전이면 .2/.3)",
  ep: ["changelog/route.ts", "route-rules/route.ts"],
  run: async (a) => {
    if (!TOKEN) return out("토큰 없음 — 초안 생략");
    // 배포 훅(deploy.sh)에서 돈다 — 서버가 응답을 안 줘도 배포가 멈추지 않게 10초 상한, 실패는 한 줄 + exit 1.
    const fail = (err: unknown): never => {
      console.error(`changelog 초안 실패 — ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    };
    const since0 = flag(a, "since");
    let rangeArg: string | undefined;
    if (since0 !== undefined) {
      try {
        rangeArg = gitRangeArg(since0);
      } catch (err) {
        return fail(err);
      }
    }
    type Ent = { version?: string | null; title?: string | null; releasedAt?: string };
    let entries: Ent[] = [];
    let shared: Ent[] = [];
    let projectId: string | null;
    try {
      // 프로젝트 해석(auto 면 route-rules) → 같은 프로젝트 항목만 앵커·버전 후보로 쓴다.
      let rules: { cwdPrefix: string; projectId: string | null; priority: number }[] = [];
      const pf = flag(a, "project");
      if (!pf || pf === "auto") {
        rules = ((await api("GET", "/api/route-rules", undefined, { timeoutMs: 10_000 })) as { rules?: typeof rules }).rules ?? [];
      }
      const resolved = resolveDraftProject(pf, rules, process.cwd());
      projectId = resolved.projectId;
      if (resolved.warning) console.error(resolved.warning);
      const list = (await api("GET", `/api/changelog?project=${encodeURIComponent(projectId ?? "none")}`, undefined, { timeoutMs: 10_000 })) as { entries?: typeof entries };
      entries = list.entries ?? [];
      // 이 프로젝트에 항목이 아직 없으면 공용 목록으로 앵커를 폴백한다(공용 초안이 이미 덮은 커밋 재나열 방지).
      if (projectId && entries.length === 0) {
        const sl = (await api("GET", "/api/changelog?project=none", undefined, { timeoutMs: 10_000 })) as { entries?: Ent[] };
        shared = sl.entries ?? [];
      }
    } catch (err) {
      return fail(err);
    }
    const picked = pickAnchorSource(entries, shared);
    const since = since0 ?? picked.anchor ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    const anchorLabel = since0 !== undefined ? "--since" : picked.source === "project" ? (projectId ? "프로젝트 엔트리" : "공용 엔트리") : picked.source === "shared" ? "공용 엔트리(폴백)" : "7일";
    const { execFileSync } = await import("node:child_process");
    const logArgs = ["log", "--format=%h%x09%ad%x09%s", "--date=short", rangeArg ?? gitRangeArg(since)];
    let raw: string;
    try {
      raw = execFileSync("git", logArgs, { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return out("git 사용 불가 — 초안 생략");
    }
    const draft = draftFromCommits(parseGitLog(raw), {
      since,
      existingVersions: picked.existingVersions,
    });
    if (!draft) return out("변경 없음 — 초안 생략");
    if (bool(a, "dry-run")) return out(`프로젝트: ${projectId ?? "(공용)"}\n앵커: ${anchorLabel}\n${draft.title} (${draft.version})\n${draft.body}`);
    try {
      const r = (await api("POST", "/api/changelog", { ...draft, projectId }, { timeoutMs: 10_000 })) as { id: string };
      out(`${r.id}\t${draft.title} (${draft.version})`);
    } catch (err) {
      fail(err);
    }
  },
});
add({
  name: "rehearsal record",
  usage: "rehearsal record <output-file> [--project <id|auto|none>] [--dry-run]   (pnpm restore:rehearsal 출력을 저장한 파일에서 '---- TeamSpace 문서용 ----' 블록을 뽑아 문서 '백업 복원 리허설 <YYYY-MM-DD>'(docType report)를 만들고 id 를 출력. --project 기본 auto = cwd→프로젝트 라우트 규칙(changelog draft 와 같음). 예: pnpm restore:rehearsal | tee /tmp/r.txt; pnpm ws rehearsal record /tmp/r.txt)",
  ep: ["pages/route.ts", "pages/[id]/route.ts", "route-rules/route.ts"],
  run: async (a) => {
    const file = a.pos[0];
    if (!file) throw new Error("출력 파일이 필요합니다: ws rehearsal record <output-file>");
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
    const block = extractRehearsalBlock(readFileSync(file, "utf8"), today);
    if (!block) throw new Error("'---- TeamSpace 문서용 ----' 블록이 없습니다 — restore:rehearsal 출력 전체를 저장했는지 확인하세요");
    const pf = flag(a, "project");
    let rules: { cwdPrefix: string; projectId: string | null; priority: number }[] = [];
    if (!pf || pf === "auto") rules = ((await api("GET", "/api/route-rules")) as { rules?: typeof rules }).rules ?? [];
    const resolved = resolveDraftProject(pf, rules, process.cwd());
    if (resolved.warning) console.error("프로젝트 매핑 없음 — 공용(미분류) 문서로 만듭니다");
    if (bool(a, "dry-run")) return out(`프로젝트: ${resolved.projectId ?? "(공용)"}\n${block.title} (결과 ${block.result ?? "?"})\n${block.markdown}`);
    const { page } = (await api("POST", "/api/pages", { title: block.title, kind: "doc", projectId: resolved.projectId ?? undefined, docType: "report" })) as { page: { id: string } };
    await api("PUT", `/api/pages/${page.id}`, { markdown: block.markdown });
    out(`${page.id}\t${block.title}${block.result ? ` (${block.result})` : ""}`);
  },
});
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
    const r = (await api("GET", "/api/members")) as { members: { id: string; role: string; kind?: string; user: { email: string } }[] };
    for (const m of r.members) out(`${m.id}\t${m.role}\t${m.kind ?? "human"}\t${m.user.email}`);
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
  usage:
    "lesson ls [--project <id>] [--q <제목 검색>] [--mode required|default|ondemand] [--limit n]   (팀 작업규칙·레슨 — 각 레슨에 scope(personal|project|stack|global)·mode. 개인 레슨은 내 것만(admin 은 전부). limit 생략=전체, 최대 300)",
  ep: ["lessons/route.ts"],
  run: async (a) => {
    const qs = new URLSearchParams();
    const pid = flag(a, "project");
    const q = flag(a, "q");
    const limit = flag(a, "limit");
    const mode = flag(a, "mode");
    if (pid) qs.set("projectId", pid);
    if (q) qs.set("q", q);
    if (mode) qs.set("mode", mode);
    if (limit) qs.set("limit", limit);
    out(await api("GET", `/api/lessons${qs.size ? `?${qs}` : ""}`));
  },
});
add({
  name: "lesson add",
  usage:
    'lesson add <title> --body "<규칙 본문>" [--project <id> | --stack <next|supabase…> | --personal] [--mode required|default|ondemand]   (범위 없으면 전역 — 모든 레포 세션에 주입. --personal = 나(토큰이면 발급자) 세션에만. mode: required 필수(예산 먼저)·default·ondemand 세션 주입 제외)',
  ep: ["lessons/route.ts"],
  run: async (a) =>
    out(
      await api("POST", "/api/lessons", {
        title: a.pos[0],
        body: flag(a, "body"),
        projectId: flag(a, "project"),
        stack: flag(a, "stack"),
        ...(bool(a, "personal") ? { personal: true } : {}),
        ...(flag(a, "mode") ? { mode: flag(a, "mode") } : {}),
      }),
    ),
});
add({
  name: "lesson show",
  usage: "lesson show <id>   (레슨 전문 — 세션 주입에는 제목·요약만 들어간다)",
  ep: ["lessons/[id]/route.ts"],
  run: async (a) => {
    const { lesson } = (await api("GET", `/api/lessons/${a.pos[0]}`)) as {
      lesson: { title: string; body: string; projectId: string | null; stack?: string | null; personal?: boolean; mode?: string };
    };
    const scope = lesson.personal ? "개인" : lesson.projectId ? `프로젝트 ${lesson.projectId}` : lesson.stack ? `스택 ${lesson.stack}` : "전역";
    const mode = lesson.mode && lesson.mode !== "default" ? ` · ${LESSON_MODE_KO[lesson.mode] ?? lesson.mode}` : "";
    out(`# ${lesson.title}  [${scope}${mode}]\n\n${lesson.body}`);
  },
});
add({
  name: "lesson set",
  usage:
    'lesson set <id> [--title <t>] [--body "<본문>"] [--project <id> | --stack <tag> | --personal | --global] [--mode required|default|ondemand]   (범위는 하나: 개인·프로젝트·스택·전역)',
  ep: ["lessons/[id]/route.ts"],
  run: async (a) => {
    const body: Record<string, unknown> = {};
    if (flag(a, "title")) body.title = flag(a, "title");
    if (flag(a, "body")) body.body = flag(a, "body");
    if (flag(a, "mode")) body.mode = flag(a, "mode");
    if (bool(a, "global")) Object.assign(body, { projectId: null, stack: null, personal: false });
    else if (bool(a, "personal")) body.personal = true;
    else if (flag(a, "project")) body.projectId = flag(a, "project");
    else if (flag(a, "stack")) body.stack = flag(a, "stack");
    out(await api("PATCH", `/api/lessons/${a.pos[0]}`, body));
  },
});
add({
  name: "lesson rm",
  usage: "lesson rm <id>",
  ep: ["lessons/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/lessons/${a.pos[0]}`)),
});
// ── 레슨 주입 점검(설정 › 레슨 주입 점검) — 시뮬레이터·연결 점검 / 주입 기록·정리 후보 ──
const LESSON_STATUS_KO: Record<string, string> = { gist: "요약 포함", title: "제목만", omitted: "잘림('외 N개')", not_applicable: "해당 없음" };
const LESSON_SCOPE_KO: Record<string, string> = { required: "필수", personal: "개인", project: "프로젝트", stack: "스택", global: "전역" };
const LESSON_MODE_KO: Record<string, string> = { required: "필수", default: "기본", ondemand: "필요할 때만" };
add({
  name: "lesson inspect",
  usage: "lesson inspect [--cwd <path> | --project <id>] [--md]   (세션 주입 시뮬레이션: 레슨별 상태·섹션 예산·연결 점검, --md 는 레슨 섹션 미리보기 — 편집자 이상)",
  ep: ["lessons/inspect/route.ts"],
  run: async (a) => {
    const q = new URLSearchParams();
    const cwd = flag(a, "cwd");
    const project = flag(a, "project");
    if (cwd) q.set("cwd", cwd);
    else if (project) q.set("projectId", project);
    type Sec = { kind: string; tag: string | null; count: number; budget: number | null; used: number; gist: number; title: number; omitted: number };
    const r = (await api("GET", `/api/lessons/inspect${q.size ? `?${q}` : ""}`)) as {
      resolved: { resolution: string; cwd: string | null; projectName: string | null; projectStack: string[] };
      budget: { contextBudget: number; lessonBudget: number | null; lessonChars: number; totalChars: number };
      sections: Sec[];
      preview: string;
      statusCounts: Record<string, number>;
      modeCounts?: Record<string, number>;
      scopeCounts?: Record<string, number>;
      lessons: { id: string; title: string; scope: string; mode?: string; status: string; reason?: string | null }[];
      linkChecks: {
        windowDays: number;
        unmappedCwds: { cwd: string; count: number }[];
        emptyStackProjects: { name: string; mapped: boolean; missedStackLessons: number }[];
        orphanStackLessons: { id: string; title: string; stack: string }[];
        brokenRouteRules: { cwdPrefix: string; projectId: string }[];
      };
    };
    if (bool(a, "md")) return out(r.preview);
    const res = r.resolved;
    const how: Record<string, string> = {
      cwd: `cwd ${res.cwd}`,
      project_rule: `프로젝트 규칙 cwd ${res.cwd}`,
      project_unmapped: "cwd 매핑 없음 — 실제로는 주입되지 않음(매핑했다면의 추정)",
      none: "cwd 없음(워크스페이스 기본)",
    };
    out(`■ 대상: ${res.projectName ?? "프로젝트 없음"}${res.projectStack.length ? ` [${res.projectStack.join(", ")}]` : ""} · ${how[res.resolution] ?? res.resolution}`);
    const b = r.budget;
    out(`■ 글자 수: 전체 ${b.totalChars.toLocaleString("ko-KR")} / ${b.contextBudget.toLocaleString("ko-KR")} · 레슨 ${b.lessonChars.toLocaleString("ko-KR")} (레슨 예산 ${b.lessonBudget?.toLocaleString("ko-KR") ?? "—"})`);
    for (const s of r.sections) {
      out(`  ${LESSON_SCOPE_KO[s.kind] ?? s.kind}${s.tag ? `:${s.tag}` : ""}\t${s.count}개 · 요약 ${s.gist} · 제목만 ${s.title} · 잘림 ${s.omitted} · ${s.used}/${s.budget ?? "—"}자`);
    }
    out(`■ 레슨 상태: ${Object.entries(r.statusCounts).map(([k, v]) => `${LESSON_STATUS_KO[k] ?? k} ${v}`).join(" · ")}`);
    if (r.scopeCounts) out(`■ 범위: ${Object.entries(r.scopeCounts).map(([k, v]) => `${LESSON_SCOPE_KO[k] ?? k} ${v}`).join(" · ")}`);
    if (r.modeCounts) out(`■ 주입 방식: ${Object.entries(r.modeCounts).map(([k, v]) => `${LESSON_MODE_KO[k] ?? k} ${v}`).join(" · ")}`);
    const required = r.lessons.filter((l) => l.mode === "required");
    if (required.length) {
      out(`  필수 레슨 ${required.length}개:`);
      for (const l of required) out(`    ${l.id}  [${LESSON_SCOPE_KO[l.scope] ?? l.scope}] ${LESSON_STATUS_KO[l.status] ?? l.status} — ${l.title}`);
    }
    const omitted = r.lessons.filter((l) => l.status === "omitted");
    if (omitted.length) {
      out(`  잘린 레슨 ${omitted.length}개:`);
      for (const l of omitted) out(`    ${l.id}  [${LESSON_SCOPE_KO[l.scope] ?? l.scope}${l.mode && l.mode !== "default" ? `·${LESSON_MODE_KO[l.mode] ?? l.mode}` : ""}] ${l.title}`);
    }
    const c = r.linkChecks;
    const warn = c.unmappedCwds.length + c.emptyStackProjects.length + c.orphanStackLessons.length + c.brokenRouteRules.length;
    out(`■ 연결 점검: ${warn ? `경고 ${warn}건` : "문제 없음"}`);
    for (const x of c.unmappedCwds) out(`  ⚠ 최근 ${c.windowDays}일 주입 cwd 가 프로젝트에 안 붙음: ${x.cwd} (${x.count}회) → pnpm ws route-rule add`);
    for (const x of c.emptyStackProjects) out(`  ⚠ stack 이 빈 프로젝트${x.mapped ? "" : "(매핑 없음)"}: ${x.name} — 스택 레슨 ${x.missedStackLessons}개를 못 받음`);
    for (const x of c.orphanStackLessons) out(`  ⚠ 맞는 프로젝트가 없는 스택 레슨: ${x.id} [${x.stack}] ${x.title}`);
    for (const x of c.brokenRouteRules) out(`  ⚠ 없는 프로젝트를 가리키는 route-rule: ${x.cwdPrefix} → ${x.projectId}`);
  },
});
add({
  name: "lesson injections",
  usage: "lesson injections [--days 30]   (레슨 주입 기록: 프로젝트별 횟수·최근 주입·정리 후보 — 편집자 이상, 1~90일)",
  ep: ["lessons/injections/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/lessons/injections?days=${encodeURIComponent(flag(a, "days") ?? "30")}`)) as {
      days: number;
      totals: { injections: number; last7: number; reads: number };
      byProject: { projectName: string | null; projectId: string | null; last7: number; lastN: number }[];
      recent: { at: string; actorName: string | null; projectName: string | null; cwd: string | null; via: string; mode: string; gist: number; titleOnly: number; omitted: number; chars: number }[];
      lessons: { id: string; title: string; gist: number; titleOnly: number; omitted: number; reads: number }[];
      cleanup: {
        alwaysTruncated: { id: string; title: string }[];
        neverInjected: { id: string; title: string }[];
        similarTitles: { a: { id: string; title: string }; b: { id: string; title: string }; score: number }[];
      };
    };
    out(`■ 최근 ${r.days}일 주입 ${r.totals.injections}회 (7일 ${r.totals.last7}회) · 에이전트 전문 조회 ${r.totals.reads}회`);
    for (const p of r.byProject) out(`  ${p.projectName ?? (p.projectId ? p.projectId : "(프로젝트 미매핑)")}\t7일 ${p.last7} · ${r.days}일 ${p.lastN}`);
    if (r.recent.length) {
      out("■ 최근 주입");
      for (const x of r.recent.slice(0, 10)) out(`  ${x.at.slice(0, 16).replace("T", " ")} ${x.via}/${x.mode} ${x.projectName ?? "—"} · 요약 ${x.gist} 제목 ${x.titleOnly} 잘림 ${x.omitted} · ${x.chars}자 · ${x.actorName ?? ""}`);
    }
    const read = r.lessons.filter((l) => l.reads > 0).sort((x, y) => y.reads - x.reads);
    if (read.length) out(`■ 많이 조회된 레슨: ${read.slice(0, 5).map((l) => `${l.title}(${l.reads})`).join(", ")}`);
    const c = r.cleanup;
    out(`■ 정리 후보 — 늘 잘림 ${c.alwaysTruncated.length} · 주입 0회 ${c.neverInjected.length} · 제목 비슷한 쌍 ${c.similarTitles.length}`);
    for (const l of c.alwaysTruncated) out(`  늘 잘림: ${l.id} ${l.title}`);
    for (const l of c.neverInjected) out(`  주입 0회: ${l.id} ${l.title}`);
    for (const p of c.similarTitles) out(`  비슷함(${p.score}): ${p.a.title} ↔ ${p.b.title}  (${p.a.id} · ${p.b.id})`);
  },
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
  usage: "inbox ls [--unread] [--group] [--type approval,assigned,mention,due,proposal,shared]   (내 알림 인박스, --group 은 같은 종류·링크 24h 묶음, 모르는 종류는 400)",
  ep: ["notifications/route.ts"],
  run: async (a) => {
    const qs = new URLSearchParams();
    if (bool(a, "unread")) qs.set("unread", "1");
    const type = flag(a, "type");
    if (type) qs.set("type", type);
    if (bool(a, "group")) {
      qs.set("group", "1");
      const g = (await api("GET", `/api/notifications?${qs}`)) as { groups: { type: string; link: string | null; count: number; unread: number; latestAt: string; sample: string[] }[]; unread: number };
      out(`미읽음 ${g.unread}건 · ${g.groups.length}묶음`);
      for (const x of g.groups) out(`[${x.type}] ${x.count}건(미읽음 ${x.unread}) ${x.latestAt.slice(0, 16)}	${x.sample[0] ?? ""}${x.link ? `	${x.link}` : ""}`);
      return;
    }
    const r = (await api("GET", `/api/notifications${qs.size ? `?${qs}` : ""}`)) as { notifications: { id: string; type: string; title: string; readAt: string | null; createdAt: string }[]; unread: number; byType?: Record<string, number> };
    const parts = Object.entries(r.byType ?? {}).map(([k, v]) => `${k} ${v}`);
    out(`미읽음 ${r.unread}건${parts.length ? ` (${parts.join(" · ")})` : ""}`);
    for (const n of r.notifications) out(`${n.readAt ? " " : "●"} ${n.id}	[${n.type}] ${n.title}`);
  },
});
add({
  name: "inbox digest",
  usage: "inbox digest [--hours <n>]   (최근 n시간(기본 24) 내 알림 요약: 총·미읽음·종류별·상위 묶음 5)",
  ep: ["notifications/digest/route.ts"],
  run: async (a) => {
    const h = flag(a, "hours");
    const d = (await api("GET", `/api/notifications/digest${h ? `?hours=${encodeURIComponent(h)}` : ""}`)) as { since: string; until: string; total: number; unread: number; byType: Record<string, number>; topGroups: { type: string; count: number; unread: number; sample: string[] }[] };
    out(`${d.since.slice(0, 16)} ~ ${d.until.slice(0, 16)}: 총 ${d.total}건 · 미읽음 ${d.unread}건 (${Object.entries(d.byType).map(([k, v]) => `${k} ${v}`).join(" · ") || "없음"})`);
    for (const g of d.topGroups) out(`[${g.type}] ${g.count}건(미읽음 ${g.unread})	${g.sample[0] ?? ""}`);
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
  usage: "project set <id> [--name <n>] [--desc <d>] [--color <c>] [--repo <url>] [--stack next,supabase]   (--stack: 스택 레슨 주입 대상)",
  ep: ["projects/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/projects/${a.pos[0]}`, { name: flag(a, "name"), description: flag(a, "desc"), color: flag(a, "color"), repoUrl: flag(a, "repo"), stack: flag(a, "stack") })),
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

// 라이브 세션 보드 · 공유 브랜치 푸시/배포 잠금 (Console 4) — scripts/wsLock.ts. 잠금은 경고용, 푸시를 막지 않는다.
const lockDeps = () => ({ api, apiRaw, log: (l: string) => console.log(l) });
add({
  name: "sessions live",
  usage: "sessions live   (라이브 세션 — 레포·브랜치·워크트리·에이전트·진행 중 태스크·마지막 활동 + 살아 있는 잠금)",
  ep: ["sessions/live/route.ts"],
  run: async () => sessionsLive(lockDeps()),
});
add({
  name: "session heartbeat",
  usage: "session heartbeat [<claude 세션 id>]   (마지막 활동 갱신 — 보통 PostToolUse 훅이 10분마다 자동. 기본 env CLAUDE_CODE_SESSION_ID)",
  ep: ["sessions/heartbeat/route.ts"],
  run: async (a) => {
    const sessionId = a.pos[0] ?? process.env.CLAUDE_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) throw new Error("세션 id 가 필요합니다: ws session heartbeat <id>");
    out(await api("POST", "/api/sessions/heartbeat", { sessionId, cwd: process.env.INIT_CWD ?? process.cwd() }));
  },
});
add({
  name: "lock take",
  usage:
    "lock take <name> [--ttl 30m] [--note \"...\"] [--cwd <path>]   (공유 브랜치·배포 예약 — 예: banjang/develop · teamspace/main · deploy/teamspace. 이름은 정규형으로 맞춤 — teamspace-main = teamspace/main. 기본 30분·최대 4h, 내 것이면 연장, 남의 것이면 보유자·메모·남은 시간과 함께 실패)",
  ep: ["locks/[name]/route.ts"],
  run: async (a) => lockTake(lockDeps(), a.pos[0], { ttl: flag(a, "ttl"), note: flag(a, "note"), cwd: flag(a, "cwd") }),
});
add({
  name: "lock extend",
  usage: "lock extend <name> [--ttl 30m]   (내 잠금 만료를 지금부터 다시 ttl 만큼)",
  ep: ["locks/[name]/route.ts"],
  run: async (a) => lockExtend(lockDeps(), a.pos[0], { ttl: flag(a, "ttl") }),
});
add({
  name: "lock release",
  usage: "lock release <name>   (내 잠금 해제. 남의 잠금은 관리자가 설정 › 라이브 세션·잠금 에서 강제 해제)",
  ep: ["locks/[name]/route.ts"],
  run: async (a) => lockRelease(lockDeps(), a.pos[0]),
});
add({
  name: "lock ls",
  usage: "lock ls   (살아 있는 잠금 — 이름·보유자·나이·남은 시간·브랜치·메모)",
  ep: ["locks/route.ts"],
  run: async () => lockLs(lockDeps()),
});
add({
  name: "lock notify",
  usage: "lock notify <name>   (남이 잡은 잠금 보유자에게 '푸시했다' 알림 — 보통 pre-push 훅이 자동, 잠금당 5분 1회)",
  ep: ["locks/[name]/notify/route.ts"],
  run: async (a) => {
    const name = a.pos[0];
    if (!name) throw new Error("잠금 이름이 필요합니다: ws lock notify <name>");
    out(await api("POST", `${lockPath(name)}/notify`, { session: process.env.CLAUDE_SESSION_ID ?? process.env.CLAUDE_CODE_SESSION_ID }));
  },
});
add({
  name: "lock install-hook",
  usage: "lock install-hook [--repo <path>]   (그 레포에 git pre-push 경고 훅 설치·갱신. 기존 pre-push 는 보존해 이어 부름, core.hooksPath 레포는 거부)",
  ep: [],
  run: async (a) => lockInstallHook(lockDeps(), { repo: flag(a, "repo"), hookSource: resolve(__dirname, "hooks", "git-pre-push.mjs") }),
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
// ── HTML 퍼블리시 (초대 게스트 전용) ──
async function siteUpload(path: string, url: string, extra: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const { bundleFromPath } = await import("../lib/sites/pathBundle");
  const b = bundleFromPath(path);
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(b.data)]), b.filename);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  const res = await fetch(`${BASE}${url}`, { method: "POST", headers: TOKEN ? { "x-ws-token": TOKEN } : {}, body: form });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // multipart 라 api() 를 우회한다(import 와 같은 이유) — 실패를 exit 1 로 전파.
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${JSON.stringify(payload)}`);
  return payload;
}
const emailsArg = (a: Args) => [...a.pos.slice(1), ...(flag(a, "invite") ?? "").split(",")].map((s) => s.trim()).filter(Boolean);

add({
  name: "site ls",
  usage: "site ls   (퍼블리시한 HTML 페이지 목록 — api 열은 API 프록시 upstream, 옛 주소가 있으면 마지막 열)",
  ep: ["sites/route.ts"],
  run: async () => {
    const { sites } = (await api("GET", "/api/sites")) as { sites: { id: string; title: string; status: string; currentVersion: number; inviteCount: number; url: string; apiUpstream?: string | null; aliases?: string[] }[] };
    for (const s of sites) out(`${s.id}\t${s.title}\tv${s.currentVersion}\t초대 ${s.inviteCount}\t${s.status}\t${s.url}\tapi ${s.apiUpstream ?? "-"}${s.aliases?.length ? `\t옛 주소 ${s.aliases.join(",")}` : ""}`);
  },
});
add({
  name: "site access",
  usage: "site access <siteId>   (계정별 접근 이력 — 열람 횟수·처음·마지막)",
  ep: ["sites/[id]/access/route.ts"],
  run: async (a) => {
    const { accounts } = (await api("GET", `/api/sites/${a.pos[0]}/access`)) as {
      accounts: { email: string; kind: string; count: number; firstAt: string; lastAt: string }[];
    };
    if (!accounts.length) return out("아직 열어본 사람이 없습니다.");
    for (const x of accounts) out(`${x.email}\t${x.kind}\t${x.count}회\t처음 ${x.firstAt}\t마지막 ${x.lastAt}`);
  },
});
add({
  name: "site show",
  usage: "site show <siteId>   (site.apiUpstream = API 프록시 대상)",
  ep: ["sites/[id]/route.ts"],
  // JSON 한 줄 그대로(파이프로 jq 에 넘기는 사용처) — upstream 은 site.apiUpstream 필드로 보인다.
  run: async (a) => out(await api("GET", `/api/sites/${a.pos[0]}`)),
});
add({
  name: "site api",
  usage: "site api <siteId> <http://127.0.0.1:<port>|--off>   (페이지의 상대경로 fetch('api/..') 를 로컬 서버로 프록시 — 루프백만)",
  ep: ["sites/[id]/route.ts"],
  run: async (a) => {
    const id = a.pos[0];
    const off = bool(a, "off");
    const upstream = a.pos[1];
    if (!id || (!off && !upstream)) throw new Error("사용법: pnpm ws site api <siteId> http://127.0.0.1:<port>  |  pnpm ws site api <siteId> --off");
    const { site } = (await api("PATCH", `/api/sites/${id}`, { apiUpstream: off ? null : upstream })) as { site: { id: string; title: string; apiUpstream: string | null } };
    out(site.apiUpstream ? `${site.id}\t${site.title}\tapi → ${site.apiUpstream}` : `${site.id}\t${site.title}\tapi 프록시 해제`);
  },
});
add({
  name: "site publish",
  usage: "site publish <file.html|dir|file.zip> [--title T] [--slug <영문-kebab>] [--project <id>] [--invite a@gmail.com,b@gmail.com] [--site <id>(새 버전)]",
  ep: ["sites/route.ts", "sites/[id]/route.ts", "sites/[id]/versions/route.ts", "sites/[id]/invites/route.ts"],
  run: async (a) => {
    const src = a.pos[0];
    if (!src) throw new Error("경로가 필요합니다. 예: pnpm ws site publish ./dist --invite guest@gmail.com");
    const siteId = flag(a, "site");
    const invites = (flag(a, "invite") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const slug = flag(a, "slug");
    let id: string;
    let url: string;
    let payload: Record<string, unknown>;
    if (siteId) {
      // 기존 사이트 주소 바꾸기 — 옛 주소는 별칭으로 남아 새 주소로 넘어간다. 형식·중복 오류면 올리기 전에 멈춘다.
      if (slug) await api("PATCH", `/api/sites/${siteId}`, { slug });
      payload = await siteUpload(src, `/api/sites/${siteId}/versions`);
      id = siteId;
      url = ((await api("GET", `/api/sites/${siteId}`)) as { url: string }).url;
      if (invites.length) await api("POST", `/api/sites/${siteId}/invites`, { emails: invites });
      out(`새 버전 v${payload.version} 을 올렸습니다.`);
    } else {
      const extra: Record<string, string> = {};
      if (flag(a, "title")) extra.title = flag(a, "title")!;
      if (flag(a, "project")) extra.projectId = flag(a, "project")!;
      if (slug) extra.slug = slug;
      if (invites.length) extra.invites = invites.join(",");
      payload = await siteUpload(src, "/api/sites", extra);
      id = (payload.site as { id: string }).id;
      url = payload.url as string;
      const inv = payload.invites as { added: string[]; invalid: string[] };
      if (inv.invalid.length) out(`⚠ 형식이 틀린 이메일: ${inv.invalid.join(", ")}`);
    }
    for (const w of (payload.warnings as string[] | undefined) ?? []) out(`⚠ ${w}`);
    out(`사이트 ${id}\n링크: ${url}`);
    if (invites.length) out(`보낼 문구: 이 링크를 열고 ${invites.join(", ")} 계정으로 Google 로그인하세요: ${url}`);
  },
});
add({
  name: "site set",
  usage: "site set <siteId> [--slug <영문-kebab>] [--title T]   (주소·제목 바꾸기 — 옛 주소는 계속 열리고 새 주소로 308)",
  ep: ["sites/[id]/route.ts"],
  run: async (a) => {
    const id = a.pos[0];
    const body: Record<string, string> = {};
    if (flag(a, "slug")) body.slug = flag(a, "slug")!;
    if (flag(a, "title")) body.title = flag(a, "title")!;
    if (!id || !Object.keys(body).length) throw new Error("사용법: pnpm ws site set <siteId> --slug banjang-handover [--title T]");
    const { site, url } = (await api("PATCH", `/api/sites/${id}`, body)) as { site: { id: string; title: string; slug: string }; url: string };
    out(`${site.id}\t${site.title}\t${url}`);
  },
});
add({
  name: "site invite",
  usage: "site invite <siteId> <email...>",
  ep: ["sites/[id]/invites/route.ts"],
  run: async (a) => out(await api("POST", `/api/sites/${a.pos[0]}/invites`, { emails: emailsArg(a) })),
});
add({
  name: "site uninvite",
  usage: "site uninvite <siteId> <email...>   (즉시 접근 차단)",
  ep: ["sites/[id]/invites/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/sites/${a.pos[0]}/invites`, { emails: emailsArg(a) })),
});
add({
  name: "site disable",
  usage: "site disable <siteId>   (링크 차단)",
  ep: ["sites/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/sites/${a.pos[0]}`, { status: "disabled" })),
});
add({
  name: "site enable",
  usage: "site enable <siteId>",
  ep: ["sites/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/sites/${a.pos[0]}`, { status: "active" })),
});
add({
  name: "site rollback",
  usage: "site rollback <siteId> <version>",
  ep: ["sites/[id]/route.ts"],
  run: async (a) => out(await api("PATCH", `/api/sites/${a.pos[0]}`, { currentVersion: Number(a.pos[1]) })),
});
// 인테이크(게스트가 폼으로 보낸 계정 정보). 값은 SITE_INTAKE_KEY 로 암호화돼 있고,
// 'site intake show' 만 복호화한다 — 그 호출은 활동 로그에 열람으로 남는다.
add({
  name: "site intake",
  usage: "site intake <siteId>   (퍼블리시 페이지로 받은 계정 정보 목록 — 값은 안 보인다)",
  ep: ["sites/[id]/intake/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/sites/${a.pos[0]}/intake`)) as {
      entries: { id: string; service: string; fieldCount: number; submittedBy: string; createdAt: string; revealCount: number }[];
      keyMissing: boolean;
    };
    if (r.keyMissing) out("⚠ SITE_INTAKE_KEY 가 설정되지 않았습니다 — 새 제출은 거절되고, 이미 받은 값도 못 풉니다.");
    if (!r.entries.length) return out("아직 받은 계정 정보가 없습니다.");
    for (const e of r.entries) out(`${e.id}\t${e.service}\t${e.fieldCount}칸\t${e.submittedBy}\t${e.createdAt}\t열람 ${e.revealCount}회`);
  },
});
add({
  name: "site intake show",
  usage: "site intake show <siteId> <entryId> [--reveal]   (기본은 가림 — --reveal 이어야 평문, 열람은 활동 로그에 남는다)",
  ep: ["sites/[id]/intake/[entryId]/route.ts"],
  run: async (a) => {
    const reveal = Boolean(a.flags.reveal);
    const { entry } = (await api("GET", `/api/sites/${a.pos[0]}/intake/${a.pos[1]}`)) as {
      entry: { service: string; submittedBy: string; createdAt: string; fields: { label: string; value: string }[] };
    };
    out(`# ${entry.service}  (${entry.submittedBy} · ${entry.createdAt})`);
    for (const f of entry.fields) {
      // 평문 자격 증명은 셸 히스토리·스크롤백·tmux 캡처·script 로그에 그대로 남는다.
      // 기본을 가림으로 두고, 정말 볼 때만 --reveal 로 켠다.
      out(`${f.label}\t${reveal ? f.value : `•`.repeat(Math.min(f.value.length, 12)) + ` (${f.value.length}자)`}`);
    }
    if (reveal) console.error("⚠ 평문을 출력했습니다 — 터미널 스크롤백·로그에 남습니다. 필요한 곳에 옮긴 뒤 `site intake rm` 으로 지우세요.");
    else out("(값을 보려면 --reveal — 어느 쪽이든 이 조회는 열람으로 기록됩니다)");
  },
});
add({
  name: "site intake rm",
  usage: "site intake rm <siteId> <entryId>   (진짜 있어야 할 곳으로 옮긴 뒤 지운다)",
  ep: ["sites/[id]/intake/[entryId]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/sites/${a.pos[0]}/intake/${a.pos[1]}`)),
});
add({
  name: "site rm",
  usage: "site rm <siteId>   (소프트 삭제 — 링크 즉시 차단)",
  ep: ["sites/[id]/route.ts"],
  run: async (a) => out(await api("DELETE", `/api/sites/${a.pos[0]}`)),
});
add({
  name: "similar",
  usage: "similar <pageId|--q 질의> [--limit n] [--archived]   (벡터 유사도 — 격차 G2. 신경망 임베딩이 아니라 TF-IDF 코사인. 보관 문서는 --archived 일 때만)",
  ep: ["search/similar/route.ts"],
  run: async (a) => {
    const q = flag(a, "q");
    const qs = q ? `q=${encodeURIComponent(q)}` : `pageId=${a.pos[0]}`;
    const r = (await api("GET", `/api/search/similar?${qs}&limit=${flag(a, "limit") ?? 5}${bool(a, "archived") ? "&archived=1" : ""}`)) as {
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
  usage: 'concept <검색어> [--archived]   (개념 검색 — LLM 질의확장으로 연관 문서까지 회수. 보관 문서는 --archived 일 때만)',
  ep: ["search/concept/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/search/concept?q=${encodeURIComponent(a.pos[0] ?? "")}${bool(a, "archived") ? "&archived=1" : ""}`)) as {
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
  usage: "graph [--types doc,project,…] [--kinds link,ref,…] [--project <id> [--hops 1|2]]   (지식 그래프 — 노드 6종·근거 태그 간선)",
  ep: ["graph/route.ts"],
  run: async (a) => {
    const q = new URLSearchParams();
    const t = flag(a, "types"); if (t) q.set("types", t);
    const k = flag(a, "kinds"); if (k) q.set("kinds", k);
    const pj = flag(a, "project"); if (pj) q.set("project", pj);
    const hp = flag(a, "hops"); if (hp) q.set("hops", hp);
    out(await api("GET", `/api/graph${q.size ? `?${q}` : ""}`));
  },
});
add({
  name: "graph neighbors",
  usage: "graph neighbors <id> [--depth 1|2]   (노드의 이웃 — 관계 종류·근거 태그)",
  ep: ["graph/neighbors/route.ts"],
  run: async (a) => {
    const r = (await api("GET", `/api/graph/neighbors?id=${encodeURIComponent(a.pos[0] ?? "")}&depth=${flag(a, "depth") ?? 1}`)) as {
      node: { title: string; type: string }; neighbors: { id: string; title: string; type: string; kind: string; tag: string; direction: string; hop: number }[];
    };
    out(`${r.node.title} [${r.node.type}] — 이웃 ${r.neighbors.length}`);
    for (const n of r.neighbors) out(`${"  ".repeat(n.hop - 1)}${n.direction === "out" ? "→" : "←"} [${n.kind}/${n.tag}] ${n.title} (${n.type}) ${n.id}`);
  },
});
add({
  name: "graph infer",
  usage: "graph infer [--limit 5] [--dry-run] [--all] [--retry]   (근거 없는 문서에 LLM 연관 간선. 문서당 1회만 — --retry 로 실행 시작 이전에 시도한 문서만 다시. --all 은 남은 게 없을 때까지 반복)",
  ep: ["graph/infer/route.ts"],
  run: async (a) => {
    const limit = Number(flag(a, "limit") ?? 5);
    const dryRun = bool(a, "dry-run");
    const retry = bool(a, "retry");
    let noPick = 0;
    let skipped: number | null = null; // 첫 응답 값만 — 이후 응답은 같은 문서를 다시 센다
    // 실행 시작 시각을 한 번 잡아 매 호출에 보낸다 — 이번 실행에서 시도한 문서는 다시 안 뽑혀 --all 이 끝난다
    const retryBefore = new Date().toISOString();
    for (;;) {
      const r = (await api("POST", "/api/graph/infer", { limit, dryRun, ...(retry ? { retryBefore } : {}) })) as {
        processed: { id: string; title: string; related: { title: string; reason: string }[] }[]; remaining: number; skippedTried?: number;
      };
      if (skipped === null) skipped = r.skippedTried ?? 0;
      for (const p of r.processed) {
        out(`■ ${p.title}`);
        for (const x of p.related) out(`   ~ ${x.title}${x.reason ? `  (${x.reason})` : ""}`);
        if (p.related.length === 0) { out("   (관련 없음)"); noPick++; }
      }
      out(`남은 대상 ${r.remaining}${dryRun ? " (dry-run: 저장 안 함)" : ""}`);
      // dry-run 은 표시를 안 남기므로 반복해도 같은 문서만 다시 나온다 — 한 번만
      if (dryRun || !bool(a, "all") || r.remaining === 0 || r.processed.length === 0) break;
    }
    out(`건너뛴(이미 시도) ${skipped ?? 0}`);
    if (bool(a, "all") && noPick > 0) out(`LLM 이 연관을 못 찾은 문서 ${noPick}개`);
  },
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
  usage: "notif-rule add <event(task_created|task_status|task_assigned|task_due|comment_added|doc_saved|weekly_digest)> <channel> [--project <projectId>]",
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

// 운영 상태(관리자) — health·백업·디스크·오늘 AI 비용 + 경고. 화면: 설정 › 운영 상태
add({
  name: "ops status",
  usage: "ops status   (운영 상태: DB·워커·마지막 백업·디스크 여유·오늘 AI 비용 + 경고 — 관리자)",
  ep: ["ops/status/route.ts"],
  run: async () => {
    const r = (await api("GET", "/api/ops/status")) as {
      status: {
        checkedAt: string;
        health: { db: boolean; worker: boolean; workerAgeSec: number | null };
        backup: { dir: string; latest: string | null; ageHours: number | null; sizeBytes: number | null };
        disk: { path: string; requestedPath?: string; freeBytes: number; totalBytes: number; freeRatio: number } | null;
        llm: { todayTokens: number | null; todayUsd: number | null; budgetTokens: number; exceeded: boolean };
        build: { version: string; buildId: string | null };
      };
      warnings: { level: "warn" | "crit"; code: string; message: string }[];
    };
    const s = r.status;
    const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)}GB`;
    out(`■ 상태 (${s.checkedAt}) · v${s.build.version}${s.build.buildId ? ` (${s.build.buildId})` : ""}`);
    out(`  DB ${s.health.db ? "정상" : "끊김"} · 워커 ${s.health.worker ? "정상" : "지연"}${s.health.workerAgeSec === null ? "" : ` (하트비트 ${s.health.workerAgeSec}초 전)`}`);
    out(`■ 마지막 백업: ${s.backup.latest ? `${s.backup.latest} · ${s.backup.ageHours === null ? "?" : Math.floor(s.backup.ageHours)}시간 전${s.backup.sizeBytes === null ? "" : ` · ${(s.backup.sizeBytes / 1024 ** 2).toFixed(1)}MB`}` : "없음"} (${s.backup.dir})`);
    out(`■ 디스크: ${s.disk ? `여유 ${Math.round(s.disk.freeRatio * 1000) / 10}% (${gb(s.disk.freeBytes)} / ${gb(s.disk.totalBytes)}) · ${s.disk.path}${s.disk.requestedPath && s.disk.requestedPath !== s.disk.path ? ` (데이터 폴더 ${s.disk.requestedPath} 없음 — 상위 폴더로 측정)` : ""}` : "읽지 못함"}`);
    out(`■ 오늘 AI 비용(추정): ${s.llm.todayUsd === null ? "—" : `$${s.llm.todayUsd.toFixed(2)}`} · 토큰 ${formatTokens(s.llm.todayTokens)}${s.llm.budgetTokens > 0 ? ` / ${s.llm.budgetTokens.toLocaleString("ko-KR")}` : ""}${s.llm.exceeded ? " (예산 초과)" : ""}`);
    if (r.warnings.length === 0) out("■ 경고 없음");
    else {
      out("■ 경고");
      for (const w of r.warnings) out(`  [${w.level === "crit" ? "위험" : "주의"}] ${w.code}: ${w.message}`);
    }
  },
});

// AI 실행 경로(관리자) — 사용처·사용량·외부 중계 상태. 화면: 설정 › AI 실행 경로
add({
  name: "ai-routes",
  usage: "ai-routes [--days 7]   (AI 호출 사용처·기간 사용량·중계 상태 요약 — 에이전트 토큰 editor 이상(사람은 관리자), 기간 1~30일)",
  ep: ["ai-routes/route.ts"],
  run: async (a) => {
    type A = { calls: number; ok: number; failed: number; inputTokens: number; outputTokens: number; avgMs: number | null; p95Ms: number | null };
    const r = (await api("GET", `/api/ai-routes?days=${encodeURIComponent(flag(a, "days") ?? "7")}`)) as {
      days: number;
      relay: {
        configured: boolean; label: string; usageError: string | null;
        status: {
          process: { state: string; pid: number | null; lastExitStatus: number | null };
          health: { state: string; httpStatus: number | null; error: string | null };
          watchdog: { state: string; at: string | null; text: string | null };
          deploy: { state: string; version: string | null };
          models: { list: string[]; defaultModel: string | null };
        } | null;
        usage: { totals: A & { okRate: number | null; healthChecks: number; otherRequests: number }; byDay: (A & { day: string })[]; failureCodes: { code: string; count: number }[] } | null;
      };
      teamspace: { provider: string; models: { synthesize: string; extract: string } | null; cacheHits: number; totals: A & { cacheHits: number }; byFeature: (A & { feature: string; cacheHits: number })[] };
      cost?: { todayTokens: number; todayUsd: number | null; periodUsd: number | null; budgetTokens: number; exceeded: boolean; cacheHits: number };
      routes: { name: string; calls: number; ok: number; inputTokens: number | null; outputTokens: number | null }[];
    };
    const n = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x.toLocaleString("ko-KR"));
    const ms = (x: number | null) => (x === null ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)}초` : `${x}ms`);
    out(`■ 사용처 (최근 ${r.days}일)`);
    for (const x of r.routes) out(`  ${x.name}\t호출 ${n(x.calls)} · 성공 ${n(x.ok)} · 입력 ${n(x.inputTokens)} / 출력 ${n(x.outputTokens)} 토큰`);
    if (!r.relay.configured) out("■ 중계 서버: 설정 안 됨 (AI_RELAY_* env)");
    else {
      const s = r.relay.status;
      if (s) {
        out(`■ ${r.relay.label} 상태`);
        out(`  프로세스 ${s.process.state}${s.process.pid ? ` (PID ${s.process.pid})` : ""}${s.process.lastExitStatus !== null ? ` · 마지막 종료 ${s.process.lastExitStatus}` : ""}`);
        out(`  응답 ${s.health.state}${s.health.httpStatus ? ` (HTTP ${s.health.httpStatus})` : s.health.error ? ` (${s.health.error})` : ""}`);
        out(`  공개 입구 ${s.watchdog.state}${s.watchdog.text ? ` — ${s.watchdog.text}` : ""}${s.watchdog.at ? ` @ ${s.watchdog.at}` : ""}`);
        out(`  배포본 ${s.deploy.version ?? s.deploy.state} · 모델 ${s.models.list.length}개${s.models.defaultModel ? ` (기본 ${s.models.defaultModel})` : ""}`);
      }
      const u = r.relay.usage;
      if (!u) out(`  사용량: 읽지 못함 (${r.relay.usageError})`);
      else {
        const t = u.totals;
        out(`  사용량: ${n(t.calls)}회 · 성공률 ${t.okRate === null ? "—" : `${Math.round(t.okRate * 1000) / 10}%`} · 입력 ${n(t.inputTokens)} / 출력 ${n(t.outputTokens)} · 평균 ${ms(t.avgMs)} · p95 ${ms(t.p95Ms)} (health ${n(t.healthChecks)}회·기타 요청 ${n(t.otherRequests)}회 제외)`);
        for (const d of u.byDay) if (d.calls) out(`    ${d.day}\t${n(d.calls)}회 · 실패 ${n(d.failed)} · 입력 ${n(d.inputTokens)} / 출력 ${n(d.outputTokens)} · p95 ${ms(d.p95Ms)}`);
        if (u.failureCodes.length) out(`  실패 코드: ${u.failureCodes.map((c) => `${c.code} ${c.count}`).join(", ")}`);
      }
    }
    out(`■ TeamSpace 자체 호출 — 경로 ${r.teamspace.provider}${r.teamspace.models ? ` · 합성 ${r.teamspace.models.synthesize} · 추출 ${r.teamspace.models.extract}` : ""} · ${n(r.teamspace.totals.calls)}회 (실패 ${n(r.teamspace.totals.failed)} · 캐시 적중 ${n(r.teamspace.cacheHits)})`);
    for (const f of r.teamspace.byFeature) out(`  ${f.feature}\t${n(f.calls)}회 · 캐시 ${n(f.cacheHits ?? 0)} · 실패 ${n(f.failed)} · 평균 ${ms(f.avgMs)}`);
    if (r.cost) {
      const c = r.cost;
      const d = (x: number | null) => (x === null ? "—" : `$${x.toFixed(x > 0 && x < 0.01 ? 4 : 2)}`);
      out(`비용(추정) 오늘 ${d(c.todayUsd)} · 기간 ${d(c.periodUsd)} · 예산 ${c.budgetTokens > 0 ? `${n(c.todayTokens)}/${n(c.budgetTokens)}${c.exceeded ? " (초과 — 호출 중단)" : ""}` : `끔 (오늘 ${n(c.todayTokens)} 토큰)`}`);
    }
  },
});

// 주간 지표 스냅샷(피드백 루프 ①) — 워커가 매주 1행. 화면 없음, CLI/API 로만 본다.
type MetricsData = { docs: number; docsBytes: number; tasksOpen: number; tasksDone: number; graphNodes: number; graphEdges: number; llm: { calls: number; cacheHits: number; inputTokens: number; outputTokens: number; usd?: number | null }; injection: { count: number; chars: number }; llmCacheRows: number };
add({
  name: "metrics",
  usage: "metrics [--weeks 8] | metrics snapshot   (editor 이상 · 비용 llm.usd 행은 admin 만 · 주간 지표 표: 키·지난주·이번주·Δ · snapshot 은 이번 주 스냅샷을 지금 1회 생성 — admin)",
  ep: ["metrics/route.ts"],
  run: async (a) => {
    if (a.pos[0] === "snapshot") {
      const r = (await api("POST", "/api/metrics")) as { created: boolean; weekKey: string };
      out(r.created ? `${r.weekKey} 스냅샷을 만들었습니다.` : `${r.weekKey} 스냅샷이 이미 있습니다(그대로 둠).`);
      return;
    }
    const r = (await api("GET", `/api/metrics?weeks=${encodeURIComponent(flag(a, "weeks") ?? "8")}`)) as {
      weeks: { weekKey: string; data: MetricsData; createdAt: string }[];
      diff: { key: string; prev: number | null; cur: number | null; delta: number | null }[];
    };
    if (r.weeks.length === 0) return out("스냅샷이 아직 없습니다. `pnpm ws metrics snapshot` 으로 만들거나 워커가 주 1회 채웁니다.");
    const cur = r.weeks[0].weekKey;
    const prev = r.weeks[1]?.weekKey ?? "—";
    const f = (x: number | null | undefined) => (x == null ? "—" : x.toLocaleString("ko-KR"));
    out(`■ 주간 지표 (지난주 ${prev} → 이번주 ${cur})`);
    out("키\t지난주\t이번주\tΔ");
    for (const d of r.diff) out(`${d.key}\t${f(d.prev)}\t${f(d.cur)}\t${d.delta == null ? "—" : `${d.delta > 0 ? "+" : ""}${d.delta.toLocaleString("ko-KR")}`}`);
    if (r.weeks.length > 2) out(`이전 주: ${r.weeks.slice(2).map((w) => w.weekKey).join(", ")}`);
  },
});

// 주간 다이제스트(F6) — 워커가 Asia/Seoul 월요일 9시대에 지난주(월~일)를 weekly_digest 규칙 채널(없으면 기본 채널)로 자동 발송. 여기선 미리보기·수동 발송.
add({
  name: "digest weekly",
  usage: "digest weekly [--project <id|이름>] [--days 7 | --week] [--dry-run | --send]   (--project 없으면 cwd→프로젝트 라우트 규칙 · --days = 지금부터 n일 롤링(기본 7) · --week = 지난주 월~일(Asia/Seoul, 워커와 같은 창) · 기본 --dry-run = 마크다운 미리보기(editor) · --send = weekly_digest 규칙 채널(없으면 기본 채널)로 지금 발송(admin, 아니면 403) — 못 보내면 exit 1)",
  ep: ["digest/route.ts", "route-rules/route.ts", "projects/route.ts"],
  run: async (a) => {
    const days = flag(a, "days") ?? "7";
    const week = bool(a, "week");
    let projectId: string;
    const pf = flag(a, "project");
    if (pf) projectId = (await resolveProject(api, pf)).id;
    else {
      const rules = ((await api("GET", "/api/route-rules")) as { rules?: { cwdPrefix: string; projectId: string | null; priority: number }[] }).rules ?? [];
      const hit = pickRouteRule(rules, process.cwd());
      if (!hit) return out("프로젝트 매핑 없음 — --project <id|이름> 으로 지정하세요.");
      projectId = hit;
    }
    if (bool(a, "send")) {
      const r = await apiRaw("POST", "/api/digest", week ? { projectId, week: true, send: true } : { projectId, days: Number(days), send: true });
      const data = (r.data ?? {}) as { sent?: boolean; channels?: number; reason?: string; error?: string };
      if (!r.ok) {
        console.error(r.status === 403 ? `발송은 관리자만 할 수 있습니다(403): ${data.error ?? ""}` : `발송 실패(${r.status}): ${data.error ?? ""}`);
        process.exit(1);
      }
      if (data.sent) return out(`Slack 으로 보냈습니다(채널 ${data.channels ?? 1}곳).`);
      // 활동 0건은 실패가 아니다(보낼 게 없음) — exit 0
      if (data.reason === "empty") return out("이번 기간 활동이 없어 보내지 않았습니다.");
      console.error(`보내지 못했습니다: ${data.error ?? "알 수 없음"}${data.channels ? ` (채널 ${data.channels}곳은 성공)` : ""}`);
      process.exit(1);
    }
    const q = week ? "week=1" : `days=${encodeURIComponent(days)}`;
    const r = (await api("GET", `/api/digest?project=${encodeURIComponent(projectId)}&${q}`)) as { markdown: string };
    out(r.markdown);
  },
});

// 스킬 레지스트리(관리자) — SKILL.md 사본·낡은 사본. 화면: 설정 › 스킬 레지스트리
type SkillRegCopy = { id: string; path: string; kind: string; repo: string | null; branch: string | null; checkout: string | null; mtime: string; lines: number; status: string };
const SKILL_STATUS_KO: Record<string, string> = { canonical: "기준본", same: "같음", differs_newer: "다름(더 새것)", stale: "낡음" };
const SKILL_KIND_KO: Record<string, string> = { repo: "레포", worktree: "워크트리", global: "전역", plugin: "플러그인", other: "기타" };
add({
  name: "skills",
  usage: "skills [--stale] [--name <스킬>] [--refresh]   (SKILL.md 사본 묶음·낡은 사본 요약 — 관리자, SKILL_SCAN_ROOTS 필요)",
  ep: ["skills/registry/route.ts"],
  run: async (a) => {
    const q = new URLSearchParams();
    if (bool(a, "stale")) q.set("stale", "1");
    if (bool(a, "refresh")) q.set("refresh", "1");
    const name = flag(a, "name");
    if (name) q.set("name", name);
    const r = (await api("GET", `/api/skills/registry${q.size ? `?${q}` : ""}`)) as
      | { configured: false }
      | {
          configured: true;
          scannedAt: string;
          scan: { truncated: boolean; truncatedReason: string | null; durationMs: number; dirsVisited: number; roots: { path: string; exists: boolean }[] };
          summary: { groups: number; copies: number; staleCopies: number; groupsWithStale: number; differingCopies: number };
          groups: { name: string; scope: string; distinct: number; stale: number; differs: number; copies: SkillRegCopy[] }[];
        };
    if (!r.configured) {
      out("스킬 레지스트리: 설정 안 됨 (서버 env SKILL_SCAN_ROOTS 가 비어 있음)");
      return;
    }
    const s = r.summary;
    out(`■ 스킬 ${s.groups}개 · 사본 ${s.copies}개 · 낡은 사본 ${s.staleCopies}개(${s.groupsWithStale}개 스킬) · 기준본과 다른 사본 ${s.differingCopies}개`);
    out(`  스캔 ${new Date(r.scannedAt).toLocaleString("ko-KR")} · ${r.scan.durationMs}ms · 폴더 ${r.scan.dirsVisited}개 · 루트 ${r.scan.roots.map((x) => `${x.path}${x.exists ? "" : "(없음)"}`).join(", ")}`);
    if (r.scan.truncated) out(`  ⚠ 스캔이 한도에서 멈춤(${r.scan.truncatedReason}) — 일부 사본이 빠졌을 수 있음`);
    // 레포 사본은 보통 <체크아웃>/.claude/skills/<스킬>/SKILL.md — 그 모양이면 체크아웃만, 아니면(.agents 미러 등) 전체 경로
    const where = (c: SkillRegCopy) => {
      if (c.kind !== "repo" && c.kind !== "worktree") return c.path;
      const usual = c.checkout && /^\/\.claude\/skills\/[^/]+\/SKILL\.md$/.test(c.path.slice(c.checkout.length));
      return `${usual ? c.checkout : c.path}${c.branch ? ` [${c.branch}]` : ""}`;
    };
    const shown = r.groups.filter((g) => g.differs > 0 || name);
    for (const g of shown) {
      out(`■ ${g.name} (${g.scope}) — 사본 ${g.copies.length} · 내용 ${g.distinct}종${g.stale ? ` · 낡음 ${g.stale}` : ""}${g.differs - g.stale ? ` · 더 새것 ${g.differs - g.stale}` : ""}`);
      for (const c of g.copies) {
        if (!name && c.status === "same") continue;
        out(`  ${SKILL_STATUS_KO[c.status] ?? c.status}\t${SKILL_KIND_KO[c.kind] ?? c.kind}\t${where(c)}\t${c.lines}줄 · ${c.mtime.slice(0, 10)} · id ${c.id}`);
      }
    }
    const rest = r.groups.length - shown.length;
    if (rest > 0) out(`  (모든 사본이 같은 스킬 ${rest}개는 생략 — --name 으로 자세히)`);
    if (shown.some((g) => g.differs)) out("  비교: pnpm ws skills diff <기준본 id> <사본 id>");
  },
});

add({
  name: "skills diff",
  usage: "skills diff <a 사본 id> <b 사본 id>   (두 SKILL.md 사본의 줄 단위 diff — 관리자, id 는 ws skills 출력)",
  ep: ["skills/registry/diff/route.ts"],
  run: async (a) => {
    const [x, y] = a.pos;
    if (!x || !y) throw new Error("사본 id 두 개가 필요합니다: ws skills diff <a> <b>");
    const r = (await api("GET", `/api/skills/registry/diff?a=${encodeURIComponent(x)}&b=${encodeURIComponent(y)}`)) as
      | { configured: false }
      | { configured: true; diff: { lines: string[]; added: number; removed: number; truncated: boolean; identical: boolean } };
    if (!r.configured) {
      out("스킬 레지스트리: 설정 안 됨 (SKILL_SCAN_ROOTS)");
      return;
    }
    if (r.diff.identical) {
      out("두 사본의 내용이 같습니다.");
      return;
    }
    out(`+${r.diff.added} / -${r.diff.removed}줄`);
    for (const l of r.diff.lines) out(l);
    if (r.diff.truncated) out("… (400줄에서 자름)");
  },
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

// env 금고 — 값은 절대 화면에 출력하지 않는다(scripts/wsEnv.ts). 값 설정·열람은 웹 관리자 세션 전용.
const envDeps = () => ({ api, log: (l: string) => console.log(l) });
add({
  name: "env ls",
  usage: "env ls <project> [--env <e>]   (키 이름·버전·대상별 동기/드리프트 상태만, 값 없음 + syncGroup 불일치 경고)",
  ep: ["env/route.ts", "env/sync-groups/route.ts", "projects/route.ts"],
  run: async (a) => envLs(envDeps(), a.pos[0], flag(a, "env")),
});
add({
  name: "env import",
  usage:
    "env import <project> <env> --from <.env 경로 | ssm:/prefix> [--profile p] [--region r] [--overwrite] [--apply] [--channel <slackId>]   (기본 드라이런 · --apply 는 사람의 고위험 승인 후 반영)",
  ep: ["env/route.ts", "env/import/route.ts", "env/import/[opId]/apply/route.ts", "approvals/[id]/route.ts", "projects/route.ts"],
  run: async (a) =>
    envImport(envDeps(), {
      project: a.pos[0], env: a.pos[1], from: flag(a, "from"), profile: flag(a, "profile"), region: flag(a, "region"),
      overwrite: bool(a, "overwrite"), apply: bool(a, "apply"), channel: flag(a, "channel") ?? process.env.WS_CONFIRM_CHANNEL,
    }),
});
add({
  name: "env pull",
  usage: "env pull <project> <env> --out <path> [--force]   (0600 파일로만 기록, 값 출력 안 함)",
  ep: ["env/pull/route.ts", "projects/route.ts"],
  run: async (a) => envPull(envDeps(), { project: a.pos[0], env: a.pos[1], out: flag(a, "out"), force: bool(a, "force") }),
});
add({
  name: "env log",
  usage: "env log [<project>] [--limit <n>]   (감사 로그 — 관리자)",
  ep: ["env/log/route.ts", "projects/route.ts"],
  run: async (a) => {
    const qs = new URLSearchParams();
    if (a.pos[0]) qs.set("projectId", (await resolveProject(api, a.pos[0])).id);
    if (flag(a, "limit")) qs.set("limit", flag(a, "limit")!);
    const r = (await api("GET", `/api/env/log?${qs}`)) as {
      logs: { at: string; actorType: string; actorName: string; action: string; env: string | null; keys: string[]; viaFunnel: boolean }[];
    };
    for (const l of r.logs) out([l.at, l.action, `${l.actorType}:${l.actorName}`, l.env ?? "-", l.keys.join(",") || "-", l.viaFunnel ? "funnel" : ""].join("\t"));
  },
});
add({
  name: "env target add",
  usage:
    "env target add <project> <env> --kind dotenv|ssm|vercel|gha [--path <파일> | --prefix </경로> [--region r] [--profile p] | --vercel-project <이름> --target development|preview|production [--scope s] [--global-dir <-Q 경로>] | --repo <owner/repo> [--gh-env e]] [--account <기대 계정: AWS 계정 id·vercel 사용자·gh 로그인>]   (editor+ 토큰)",
  ep: ["env/targets/route.ts", "projects/route.ts"],
  run: async (a) =>
    envTargetAdd(envDeps(), {
      project: a.pos[0], env: a.pos[1], kind: flag(a, "kind"), account: flag(a, "account"),
      path: flag(a, "path"), prefix: flag(a, "prefix"), region: flag(a, "region"), profile: flag(a, "profile"),
      vercelProject: flag(a, "vercel-project"), target: flag(a, "target"), scope: flag(a, "scope"), globalDir: flag(a, "global-dir"),
      repo: flag(a, "repo"), ghEnv: flag(a, "gh-env"),
    }),
});
add({
  name: "env target ls",
  usage: "env target ls <project> [--env <e>]   (push 대상 목록 — 종류·설정·기대 계정·마지막 반영)",
  ep: ["env/targets/route.ts", "projects/route.ts"],
  run: async (a) => envTargetLs(envDeps(), a.pos[0], flag(a, "env")),
});
add({
  name: "env target set",
  usage: "env target set <id> [--account <기대 계정>]   (기대 계정 교체. 설정을 바꾸려면 rm 후 add)",
  ep: ["env/targets/[id]/route.ts"],
  run: async (a) => {
    const id = a.pos[0];
    if (!id) throw new Error("대상 id 가 필요합니다: ws env target set <id> --account <기대 계정>");
    const acct = flag(a, "account");
    if (!acct) throw new Error("--account <기대 계정> 이 필요합니다.");
    const cur = ((await api("GET", `/api/env/targets?${new URLSearchParams({ id })}`)) as { targets: { kind: string }[] }).targets[0];
    if (!cur) throw new Error(`대상 '${id}' 를 찾을 수 없습니다.`);
    const field = cur.kind === "ssm" ? "accountId" : cur.kind === "vercel" ? "user" : cur.kind === "gha" ? "login" : null;
    if (!field) throw new Error("로컬 .env 대상에는 기대 계정이 없습니다.");
    const r = (await api("PATCH", `/api/env/targets/${encodeURIComponent(id)}`, { account: { [field]: acct } })) as { target: { accountSummary: string } };
    out(`대상 ${id} 기대 계정: ${r.target.accountSummary}`);
  },
});
add({
  name: "env target rm",
  usage: "env target rm <id>   (대상 삭제, 원격 값은 그대로)",
  ep: ["env/targets/[id]/route.ts"],
  run: async (a) => envTargetRm(envDeps(), a.pos[0]),
});
add({
  name: "env push",
  usage:
    "env push <targetId> [--keys A,B] [--apply] [--wait] [--channel <slackId>] [--op <opId>]   (계정 확인 → 키 이름 드라이런 · --apply 는 사람의 고위험 승인 뒤 반영, --wait 는 최대 10분 대기, --op 는 승인된 작업 이어서. 운영은 터미널 yes 확인)",
  ep: [
    "env/route.ts", "env/targets/route.ts", "env/targets/[id]/push/route.ts", "env/push/[opId]/claim/route.ts",
    "env/push/[opId]/result/route.ts", "approvals/[id]/route.ts",
  ],
  run: async (a) =>
    envPush(envDeps(), {
      targetId: a.pos[0], keys: flag(a, "keys"), apply: bool(a, "apply"), wait: bool(a, "wait"),
      channel: flag(a, "channel") ?? process.env.WS_CONFIRM_CHANNEL, op: flag(a, "op"),
    }),
});

add({
  name: "env drift",
  usage:
    "env drift <targetId> | --all [--project <p>] [--env <e>]   (계정 확인 → 원격과 비교: .env 파일·SSM 은 값, Vercel·GHA 는 이름만 → 키별 상태만 서버에 기록. 값·해시는 출력·전송 안 함)",
  ep: ["env/route.ts", "env/targets/route.ts", "env/pull/route.ts", "env/targets/[id]/drift/route.ts", "projects/route.ts"],
  run: async (a) => envDrift(envDeps(), { targetId: a.pos[0], all: bool(a, "all"), project: flag(a, "project"), env: flag(a, "env") }),
});
add({
  name: "env groups",
  usage: "env groups   (syncGroup 일관성 — 같은 묶음 키의 값이 같은지, 서버가 지문으로 비교·이름만 출력)",
  ep: ["env/sync-groups/route.ts"],
  run: async () => envGroups(envDeps()),
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
