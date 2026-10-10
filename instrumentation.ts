import { openApiStartupWarning } from "@/lib/openApi";
import { validateEnv } from "@/lib/env";
import { log } from "@/lib/log";

/* Next 가 서버 인스턴스를 띄울 때 한 번 호출한다. 위험 스위치가 켜져 있으면 기동 로그에 경고하고, env 를 검증한다. */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const w = openApiStartupWarning();
  if (w) log.warn("auth.open_api", { msg: w });

  const report = validateEnv(process.env, { entry: "web", nodeEnv: process.env.NODE_ENV });
  for (const line of report.warnings) log.warn("env.warning", { msg: line, entry: "web" });
  if (report.errors.length > 0) {
    for (const line of report.errors) log.error("env.invalid", { msg: line, entry: "web" });
    if (process.env.NODE_ENV === "production") {
      throw new Error("환경변수 검증 실패 — 위 항목을 고치고 다시 시작하세요");
    }
  }
}
