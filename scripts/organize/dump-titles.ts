// 실행: pnpm exec tsx scripts/organize/dump-titles.ts > scripts/organize/fixtures/titles-2026-10-08.json
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

async function main() {
  const base = process.env.WS_BASE ?? "http://localhost:3002";
  const token = process.env.WS_TOKEN ?? (JSON.parse(readFileSync(`${homedir()}/.claude/teamspace.json`, "utf8")) as { token?: string }).token;
  const r = await fetch(`${base}/api/pages`, { headers: { "x-ws-token": token ?? "" } });
  const { pages } = (await r.json()) as { pages: { id: string; title: string; kind: string; projectId: string | null; parentId: string | null }[] };
  const docs = pages.filter((p) => p.kind === "doc").map(({ id, title, projectId, parentId }) => ({ id, title, projectId, parentId }));
  process.stdout.write(JSON.stringify(docs, null, 1));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
