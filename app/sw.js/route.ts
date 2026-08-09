import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
// 워커 파일 자체는 캐시하지 않는다 — 여기가 낡으면 새 배포가 영원히 안 붙는다.
export const dynamic = "force-dynamic";

/* =====================================================================
   GET /sw.js — 서비스 워커 서빙 (격차 F1).

   정적 파일로 두지 않고 라우트로 서빙하는 이유는 **버전 주입** 때문이다.
   워커 안의 캐시 이름이 배포마다 갈려야 옛 캐시가 정리된다. 수동으로 버전을
   올리는 방식은 반드시 잊는다(그리고 잊은 그날 캐시가 굳는다).

   Next 의 빌드 id 를 쓸 수 없는 자리라, 빌드 산출물 자체에서 안정적인 값을
   만든다: 프로세스 시작 시각. 배포하면 프로세스가 재시작되므로 값이 바뀌고,
   같은 배포 안에서는 고정이다.

   치환은 **replaceAll** 이다. replace 는 첫 번째만 바꾸는데, 워커 소스의 첫
   `__BUILD__` 는 주석 안에 있어서 정작 상수는 문자열 그대로 남았다(실제로 겪음).
   ===================================================================== */

const BUILD = String(Date.now());

export async function GET() {
  // 워커 소스는 **public/ 에 두지 않는다** — public 의 정적 파일이 같은 경로의
  // 라우트를 가려서, 버전이 주입되지 않은 원본이 그대로 서빙된다(실제로 겪음).
  const src = await readFile(path.join(process.cwd(), "app", "sw.js", "worker.js"), "utf8");
  return new Response(src.replaceAll("__BUILD__", BUILD), {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      // 스코프를 루트로 — /sw.js 위치상 기본값이지만 명시해 둔다.
      "service-worker-allowed": "/",
    },
  });
}
