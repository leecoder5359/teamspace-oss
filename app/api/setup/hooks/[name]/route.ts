import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";

// 서빙 허용 훅 화이트리스트 — scripts/hooks/ 의 실제 파일명(확장자 제외)과 일치해야 한다.
const ALLOW = new Set(["teamspace-context", "teamspace-session-end", "deny-repo-docs", "teamspace-project-context"]);

// GET /api/setup/hooks/[name] — curl 설치기가 훅 스크립트를 내려받는 엔드포인트.
// name 이 화이트리스트에 없으면(경로 탈출 시도 포함) 404 — Set 조회이므로 "../secret" 같은
// 입력도 자동으로 차단된다(파일시스템 접근이 화이트리스트된 이름으로만 일어남).
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const base = name.replace(/\.mjs$/, "");
  if (!ALLOW.has(base)) return new Response("not found", { status: 404 });
  const src = await readFile(join(process.cwd(), "scripts/hooks", `${base}.mjs`), "utf8");
  return new Response(src, { headers: { "content-type": "application/javascript; charset=utf-8" } });
}
