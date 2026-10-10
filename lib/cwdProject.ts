/**
 * cwd → 프로젝트 매핑(WorkspaceRouteRule) 해석 — CLI(changelog draft --project auto)용 순수 함수.
 * 접두사는 **경로 세그먼트 단위**로 비교한다: `/a/b` 는 `/a/b`·`/a/b/x` 에 맞고 `/a/bc` 에는 안 맞는다
 * (워크트리 `/x/teamspace-stage4a` 가 `/x/teamspace` 규칙에 잘못 걸리면 다른 제품 이력에 섞인다).
 */
export function pickRouteRule(
  rules: readonly { cwdPrefix: string; projectId: string | null; priority: number }[],
  cwd: string,
): string | null {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p) || "/";
  const here = norm(cwd);
  let best: { len: number; priority: number; projectId: string | null } | null = null;
  for (const rule of rules) {
    const prefix = norm(rule.cwdPrefix);
    const hit = prefix === "/" || here === prefix || here.startsWith(prefix + "/");
    if (!hit) continue;
    const len = prefix === "/" ? 0 : prefix.length;
    if (!best || len > best.len || (len === best.len && rule.priority > best.priority)) {
      best = { len, priority: rule.priority, projectId: rule.projectId };
    }
  }
  return best?.projectId ?? null;
}

export const NO_MAPPING_WARNING = "프로젝트 매핑 없음 — 공용 변경 이력으로 적재";

/**
 * `changelog draft --project <id|auto|none>` 해석.
 * auto(기본) = cwd 에 맞는 라우트 규칙의 프로젝트, 없으면 null + 경고 한 줄.
 * none = 명시적 공용(경고 없음). 그 외 = 지정한 id 그대로.
 */
export function resolveDraftProject(
  flagValue: string | undefined,
  rules: readonly { cwdPrefix: string; projectId: string | null; priority: number }[],
  cwd: string,
): { projectId: string | null; warning?: string } {
  const v = (flagValue ?? "auto").trim() || "auto";
  if (v === "none") return { projectId: null };
  if (v !== "auto") return { projectId: v };
  const projectId = pickRouteRule(rules, cwd);
  return projectId ? { projectId } : { projectId: null, warning: NO_MAPPING_WARNING };
}
