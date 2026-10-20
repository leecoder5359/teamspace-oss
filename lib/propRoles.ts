/* 보드 속성 → 역할(제목·상태·우선순위·담당자·마감…) 이름 휴리스틱. 보드 화면과 대시보드 서버 집계(lib/dashboardStats)가 같이 쓴다. */

/** 분류에 필요한 속성 필드만(보드 화면의 DbProperty·prisma DbProperty 둘 다 맞는다). */
export type RoleProp = { id: string; name: string; type: string };

export type Role =
  | "title"
  | "status"
  | "priority"
  | "severity"
  | "progress"
  | "label"
  | "person"
  | "date"
  | "number"
  | "checkbox"
  | "relation"
  | "text";

export function classifyRoles(props: readonly RoleProp[]): { roles: Map<string, Role>; titleId: string | null } {
  const roles = new Map<string, Role>();
  const titleProp = props.find((p) => p.type === "text") ?? props[0];
  const titleId = titleProp?.id ?? null;
  for (const p of props) {
    if (p.id === titleId) {
      roles.set(p.id, "title");
      continue;
    }
    const n = p.name.toLowerCase();
    if (p.type === "select" || p.type === "multiselect") {
      if (/상태|status|진행/.test(n)) roles.set(p.id, "status");
      else if (/우선|priority/.test(n)) roles.set(p.id, "priority");
      else if (/심각|중요|severity/.test(n)) roles.set(p.id, "severity");
      else roles.set(p.id, "label");
    } else if (p.type === "person") {
      roles.set(p.id, "person");
    } else if (p.type === "text" && /담당|assignee|manager|작성|owner/.test(n)) {
      roles.set(p.id, "person");
    } else if (p.type === "date") {
      roles.set(p.id, "date");
    } else if (p.type === "number" && /진행|progress|율|%/.test(n)) {
      roles.set(p.id, "progress");
    } else if (p.type === "number") {
      roles.set(p.id, "number");
    } else if (p.type === "checkbox") {
      roles.set(p.id, "checkbox");
    } else if (p.type === "relation") {
      roles.set(p.id, "relation");
    } else {
      roles.set(p.id, "text");
    }
  }
  return { roles, titleId };
}
