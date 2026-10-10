/* 문서 폴더 이관 — 드라이런 기본. --apply [--limit <n>] / --undo <기록docId> / --project <id> / --base <url>
 * 드라이런도 "문서 폴더 이관 기록" 문서 1건을 TeamSpace 개발 프로젝트에 만든다(되돌리기 근거). */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { applyResultSection, buildPlan, limitPlan, parseOrganizeArgs, planToMarkdown, parsePlanMarkdown, RECORD_TITLE_PREFIX, undoSummary } from "../lib/docOrganizePlan";
import type { TracksConfig } from "../lib/docOrganize";

// 분류 사전은 워크스페이스 전용(실제 프로젝트 id) — 레포에는 예시만 있고 OSS 로 나가지 않는다.
const TRACKS_PATH = new URL("./organize/tracks.json", import.meta.url);
function loadTracks(): TracksConfig {
  if (!existsSync(TRACKS_PATH)) {
    throw new Error("scripts/organize/tracks.json 이 없습니다 — tracks.example.json 을 복사해 프로젝트 id 를 채우세요");
  }
  return JSON.parse(readFileSync(TRACKS_PATH, "utf8")) as TracksConfig;
}

let opts: ReturnType<typeof parseOrganizeArgs>;
try {
  opts = parseOrganizeArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const base = opts.base ?? process.env.WS_BASE ?? "http://localhost:3002";

function readToken(): string {
  if (process.env.WS_TOKEN) return process.env.WS_TOKEN;
  try {
    return (JSON.parse(readFileSync(`${homedir()}/.claude/teamspace.json`, "utf8")) as { token?: string }).token ?? "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const headers = { "x-ws-token": readToken(), "content-type": "application/json" };
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }

  const undoId = opts.undo;
  if (undoId) {
    const { markdown } = await api<{ markdown: string }>("GET", `/api/pages/${undoId}`);
    const rows = parsePlanMarkdown(markdown).reverse();
    if (rows.length === 0) throw new Error("되돌릴 행이 없습니다 — 기록 형식이 다르거나 비어 있습니다");
    // 한 행이 실패해도(403·404 등) 나머지는 계속 되돌린다 — 앞서 적용된 행이 남지 않게.
    const failures: { id: string; reason: string }[] = [];
    for (const r of rows) {
      try {
        await api("PATCH", `/api/pages/${r.id}`, { parentId: r.fromParentId, projectId: r.fromProjectId, docType: r.fromDocType });
        console.log("undo", r.id);
      } catch (e) {
        failures.push({ id: r.id, reason: e instanceof Error ? e.message : String(e) });
        console.error("undo 실패", r.id);
      }
    }
    console.log(`${undoSummary(rows.length, failures)}. 빈 폴더는 UI 또는 'ws doc rm' 으로 정리한다.`);
    if (failures.length) process.exitCode = 1;
    return;
  }

  const { pages } = await api<{ pages: { id: string; title: string; kind: string; parentId: string | null; projectId: string | null; docType?: string | null }[] }>("GET", "/api/pages");
  const { projects } = await api<{ projects: { id: string; name: string }[] }>("GET", "/api/projects");
  const TS_PROJECT = projects.find((p) => p.name.startsWith("TeamSpace"))?.id;

  const onlyProject = opts.project;
  const apply = opts.apply;
  const full = buildPlan(onlyProject ? pages.filter((p) => p.projectId === onlyProject) : pages, loadTracks());
  const plan = opts.limit !== undefined ? limitPlan(full, opts.limit) : full;
  const today = new Date().toISOString().slice(0, 10);
  const rec = await api<{ page: { id: string } }>("POST", "/api/pages", { title: `${RECORD_TITLE_PREFIX} ${today}${apply ? "" : " (드라이런)"}`, kind: "doc", projectId: TS_PROJECT });
  await api("PUT", `/api/pages/${rec.page.id}`, { markdown: planToMarkdown(plan, projects) });
  console.log(JSON.stringify(plan.summary), `기록 doc ${rec.page.id}`);
  if (!apply) {
    console.log("드라이런. 적용하려면 --apply");
    return;
  }

  const folderId = new Map<string, string>();
  const created: { projectId: string | null; folder: string; id: string }[] = [];
  let done = 0;
  let current = "";
  let failure: { id: string; reason: string } | undefined;
  // 어디까지 했는지 기록 문서에 남긴다(성공·실패 모두) — 실패 행은 undo 때도 다시 실패할 수 있으므로 위치가 필요하다.
  try {
    for (const f of plan.folders) {
      const key = `${f.projectId}::${f.folder}`;
      if (f.exists && f.existingId) {
        folderId.set(key, f.existingId);
        continue;
      }
      current = `폴더:${f.folder}`;
      const made = await api<{ page: { id: string } }>("POST", "/api/pages", { title: f.folder, kind: "doc", projectId: f.projectId });
      folderId.set(key, made.page.id);
      created.push({ projectId: f.projectId, folder: f.folder, id: made.page.id });
      console.log("folder", f.folder, made.page.id);
    }
    // 생성한 폴더 id 를 기록에 남긴다(undo 후 빈 폴더 정리용). 중간 실패해도 남도록 문서 이동 전에 쓴다.
    if (created.length) await api("PUT", `/api/pages/${rec.page.id}`, { markdown: planToMarkdown(plan, projects, created) });
    for (const r of plan.rows) {
      current = r.id;
      const to = r.toFolder ? folderId.get(`${r.toProjectId}::${r.toFolder}`) : undefined;
      // projectId 는 바뀔 때만. 분류 불가 문서도 docType 은 기록한다.
      await api("PATCH", `/api/pages/${r.id}`, {
        ...(to ? { parentId: to } : {}),
        ...(r.toProjectId !== r.fromProjectId ? { projectId: r.toProjectId } : {}),
        docType: r.docType,
      });
      done++;
    }
  } catch (e) {
    failure = { id: current, reason: e instanceof Error ? e.message : String(e) };
    throw e;
  } finally {
    const md = planToMarkdown(plan, projects, created) + "\n" + applyResultSection(done, plan.rows.length, failure);
    await api("PUT", `/api/pages/${rec.page.id}`, { markdown: md }).catch((err) => console.error("결과 기록 실패", err instanceof Error ? err.message : err));
  }
  console.log(`적용 ${done}건. 되돌리기: pnpm exec tsx scripts/organize-docs.ts --undo ${rec.page.id}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
