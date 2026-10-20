import { describe, expect, it } from "vitest";
import { renderProjectDelta, PROJECT_DELTA_TARGET } from "./contextProject";

/* sections=project — PostToolUse 훅이 세션 레포 밖 프로젝트를 건드렸을 때의 '델타'.
   세션 시작에서 이미 받은 전역·개인·필수(전역) 레슨은 다시 싣지 않고, 그 프로젝트 범위(프로젝트·스택)만. */

const P = "pbanjang";
const L = (id: string, o: Partial<{ projectId: string | null; stack: string | null; userId: string | null; mode: string; title: string; body: string }> = {}) => ({
  id,
  title: o.title ?? `레슨 ${id}`,
  body: o.body ?? `처방: ${id} 규칙을 지킨다`,
  projectId: o.projectId ?? null,
  stack: o.stack ?? null,
  userId: o.userId ?? null,
  mode: o.mode ?? "default",
});
const lessons = [
  L("reqglob", { mode: "required" }),
  L("reqproj", { projectId: P, mode: "required" }),
  L("proj1", { projectId: P }),
  L("proj2", { projectId: P }),
  L("other", { projectId: "pother" }),
  L("stknext", { stack: "next" }),
  L("stkvue", { stack: "vue" }),
  L("glob1"),
  L("mine", { userId: "u1" }),
  L("od", { projectId: P, mode: "ondemand" }),
];
const base = {
  workspaceName: "팀",
  projectId: P,
  projectName: "반장",
  projectStack: ["next"],
  lessons,
  personId: "u1",
  tasks: [
    { title: "남의 대기", status: "시작 전", due: null, assignee: "남" },
    { title: "내 진행", status: "진행 중", due: null, assignee: "이준" },
    { title: "남의 진행", status: "진행 중", due: null, assignee: "남" },
  ],
  me: ["이준", "u1"],
  counts: { tasks: 3, docs: 40, decisions: 7 },
  accountLines: ["- SSM: dev 계정 `111`"],
};

describe("renderProjectDelta", () => {
  it("프로젝트·스택 범위 레슨만 — 전역·개인·필수(전역)·다른 프로젝트·다른 스택·ondemand 는 빠진다", () => {
    const { markdown } = renderProjectDelta(base);
    for (const id of ["reqproj", "proj1", "proj2", "stknext"]) expect(markdown).toContain(`\`${id}\``);
    for (const id of ["reqglob", "other", "stkvue", "glob1", "mine", "od"]) expect(markdown).not.toContain(`\`${id}\``);
  });

  it("필수(이 프로젝트)가 먼저, 요약 줄로", () => {
    const { markdown } = renderProjectDelta(base);
    const lines = markdown.split("\n").filter((l) => l.startsWith("- **"));
    expect(lines[0]).toContain("`reqproj`");
    expect(lines[0]).toContain(" — ");
  });

  it("세션 시작에 이미 들어간 레슨을 안내하는 한 줄이 있다", () => {
    expect(renderProjectDelta(base).markdown).toMatch(/전역·개인·필수\(전역\) 레슨은 세션 시작에 이미/);
  });

  it("머리말·계정 줄·태스크(내 담당·진행 중)·개수 줄 — 지식 지도·용어집·문서 목록·결정은 없다", () => {
    const { markdown } = renderProjectDelta(base);
    expect(markdown.split("\n")[0]).toBe("# 워크스페이스: 팀 · 프로젝트: 반장 (프로젝트 델타)");
    expect(markdown).toContain("## 계정 (env 금고 반영 대상)");
    expect(markdown).toContain("- SSM: dev 계정 `111`");
    expect(markdown).toContain("- 내 진행 — 진행 중 · 나");
    expect(markdown).toContain("- 남의 진행 — 진행 중 · 남");
    expect(markdown).not.toContain("남의 대기");
    expect(markdown).toContain("태스크 3 · 문서 40 · 결정 7 — MCP `task_list` · `doc_list` · `search`");
    for (const h of ["## 지식 지도", "## 용어집", "## 문서", "## 결정"]) expect(markdown).not.toContain(h);
  });

  it("주입 id: 보인 레슨은 gist/title, 넘친 건 omitted, 범위 밖은 기록하지 않는다", () => {
    const { ids } = renderProjectDelta(base);
    expect([...ids.gistIds, ...ids.titleIds].sort()).toEqual(["proj1", "proj2", "reqproj", "stknext"]);
    expect(ids.omittedIds).toEqual([]);
  });

  it("레슨·태스크가 많아도 목표(3,000자) 안이고 '외 N개' 로 개수를 남긴다", () => {
    const many = Array.from({ length: 60 }, (_, k) =>
      L(`cm${String(k).padStart(23, "0")}`, { projectId: P, title: `반장 프로젝트 레슨 제목은 대략 이 정도 길이로 들어온다 ${k}`, body: `처방: ${"길게 쓴 본문 ".repeat(30)}` }),
    );
    const tasks = Array.from({ length: 150 }, (_, k) => ({ title: `열린 태스크 ${k} — 카드 제목이 꽤 길게 들어오는 경우`, status: k % 2 ? "진행 중" : "시작 전", due: null, assignee: k % 7 ? "남" : "이준" }));
    const r = renderProjectDelta({ ...base, lessons: many, tasks, counts: { tasks: 150, docs: 300, decisions: 40 } });
    expect(r.markdown.length).toBeLessThanOrEqual(PROJECT_DELTA_TARGET);
    expect(r.markdown).toMatch(/외 \d+개/);
    expect(r.ids.omittedIds.length).toBeGreaterThan(0);
    expect(r.ids.gistIds.length + r.ids.titleIds.length + r.ids.omittedIds.length).toBe(60);
  });

  it("끝 자르기로 줄이 빠지면 '외 N줄' 표지를 남기고, 빠진 레슨 줄의 id 는 보인 것으로 기록하지 않는다", () => {
    const many = Array.from({ length: 6 }, (_, k) => L(`cm${String(k).padStart(23, "0")}`, { projectId: P }));
    // 계정 줄이 비정상으로 길면(상한 밖 입력) 레슨 줄까지 잘린다
    const r = renderProjectDelta({ ...base, lessons: many, accountLines: ["- " + "x".repeat(2700)] });
    expect(r.markdown.length).toBeLessThanOrEqual(PROJECT_DELTA_TARGET);
    const marks = r.markdown.split("\n").map((l) => l.match(/^- … 외 (\d+)줄 \(MCP `task_list` · `lesson_list`\)$/)).filter(Boolean);
    expect(marks).toHaveLength(1);
    const cutN = Number(marks[0]![1]);
    const shown = [...r.ids.gistIds, ...r.ids.titleIds];
    for (const id of shown) expect(r.markdown).toContain(`\`${id}\``);
    const dropped = many.map((l) => l.id).filter((id) => !r.markdown.includes(`\`${id}\``));
    expect(dropped.length).toBeGreaterThan(0);
    expect([...r.ids.omittedIds].sort()).toEqual(dropped.sort());
    expect(cutN).toBeGreaterThanOrEqual(dropped.length); // 잘린 레슨 줄 + 그 뒤 태스크·안내 줄
    expect(r.markdown.split("\n").at(-1)).toMatch(/^태스크 3 · 문서 40 · 결정 7/);
  });

  it("목표 안이면 '외 N줄' 표지가 없다", () => {
    expect(renderProjectDelta(base).markdown).not.toMatch(/외 \d+줄/);
  });

  it("count = 이 출력의 대상 레슨 수(ondemand 제외) — 보인 것 + 넘친 것", () => {
    const r = renderProjectDelta(base);
    expect(r.count).toBe(4);
    expect(r.count).toBe(r.ids.gistIds.length + r.ids.titleIds.length + r.ids.omittedIds.length);
  });

  it("범위 레슨이 없으면 (없음)", () => {
    const { markdown } = renderProjectDelta({ ...base, lessons: [L("g")] });
    expect(markdown).toContain("- (없음)");
  });

  it("프로젝트가 없으면 스택도 보지 않는다", () => {
    const { markdown } = renderProjectDelta({ ...base, projectId: null, projectName: null });
    expect(markdown).not.toContain("`stknext`");
    expect(markdown.split("\n")[0]).toBe("# 워크스페이스: 팀 (프로젝트 델타)");
  });
});
