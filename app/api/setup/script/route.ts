import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const runtime = "nodejs";

// GET /api/setup/script — `curl teamspace.example.com/setup.sh | sh` 가 실제로 받는 본문.
// next.config.ts 의 rewrites 가 /setup.sh → 이 라우트로 매핑한다.
export async function GET() {
  const sh = await readFile(join(process.cwd(), "scripts/setup/setup.sh"), "utf8");
  return new Response(sh, { headers: { "content-type": "text/x-shellscript; charset=utf-8" } });
}
