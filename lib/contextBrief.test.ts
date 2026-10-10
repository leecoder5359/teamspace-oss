import { describe, expect, it } from "vitest";
import { renderBrief, BRIEF_BYTE_TARGET } from "./contextBrief";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// 현실적 규모: 레슨 60(프로젝트 25·스택 10·전역 25), 열린 태스크 150, 문서 47
const lessons = [
  ...Array.from({ length: 25 }, (_, i) => ({ id: `cmproj${String(i).padStart(19, "0")}`, title: `반장 프로젝트 레슨 제목은 이 정도 길이다 ${i}`, body: "처방: 길게 ".repeat(40), projectId: "p1", stack: null })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `cmstck${String(i).padStart(19, "0")}`, title: `Next 스택 레슨 ${i} — 라우트 핸들러 주의`, body: "본문", projectId: null, stack: "next" })),
  ...Array.from({ length: 25 }, (_, i) => ({ id: `cmglob${String(i).padStart(19, "0")}`, title: `전역 레슨 ${i}`, body: "본문", projectId: null, stack: null })),
];
const statuses = ["시작 전", "진행 중", "검토"];
const tasks = Array.from({ length: 150 }, (_, i) => ({
  title: `열린 태스크 ${i} — 보드 카드 제목이 꽤 길게 들어오는 경우를 가정한 문장입니다`,
  status: statuses[i % 3],
  due: i % 4 === 0 ? "2026-10-20" : null,
  assignee: i % 7 === 0 ? "이준" : i % 5 === 0 ? "다른사람" : null,
}));
const base = {
  workspaceName: "팀 워크스페이스",
  projectId: "p1",
  projectName: "반장",
  projectStack: ["next"],
  lessons,
  tasks,
  me: ["이준", "u1"],
  counts: { docs: 47, decisions: 19, risks: 0, glossary: 12 },
};

describe("renderBrief", () => {
  it("현실적 규모에서도 3000 바이트 미만이고 MCP context_get 안내로 끝난다", () => {
    const md = renderBrief(base);
    expect(bytes(md)).toBeLessThan(3000);
    expect(bytes(md)).toBeLessThanOrEqual(BRIEF_BYTE_TARGET);
    expect(md).toContain("MCP context_get");
    expect(md).toContain("문서 47 · 결정 19 · 리스크 0");
  });

  it("헤더에 워크스페이스·프로젝트가 있다", () => {
    expect(renderBrief(base).split("\n")[0]).toBe("# 워크스페이스: 팀 워크스페이스 · 프로젝트: 반장");
  });

  it("레슨은 프로젝트+스택 제목·id 만, 전역은 개수만", () => {
    const md = renderBrief(base);
    expect(md).toContain("`cmproj0000000000000000000`");
    expect(md).toContain("Next 스택 레슨");
    expect(md).not.toContain("전역 레슨 0");
    expect(md).toContain("전역 25건 — MCP lesson_list");
    expect(md).not.toContain("처방"); // 본문·요약은 넣지 않는다
    expect(md).toMatch(/외 \d+개/); // 넘친 레슨은 개수로 드러낸다
  });

  it("태스크는 내 담당 + 진행 중 상위 5건만", () => {
    const md = renderBrief(base);
    expect(md).toContain("## 열린 태스크 150건");
    expect(md).toContain("- 열린 태스크 7 — 보드 카드 제목이 꽤 길게 들어오는 경우를 가정한… — 진행 중 · 나"); // 내 담당 중 진행 중이 먼저
    expect(md).toMatch(/- 열린 태스크 1 — .* — 진행 중$/m); // 남의/미배정 진행 중도 묶음 따로 보인다
    expect(md).toContain("내 담당 외");
    const sec = md.slice(md.indexOf("## 열린 태스크"));
    const inProg = sec.split("\n").filter((l) => l.startsWith("- ") && l.includes("진행 중") && !l.includes(" · 나"));
    expect(inProg.length).toBeLessThanOrEqual(5);
    expect(sec).toContain("MCP task_list");
  });

  it("userId 로 저장된 담당자(person 속성)도 내 담당으로 본다", () => {
    const md = renderBrief({ ...base, tasks: [{ title: "사람 속성 태스크", status: "시작 전", due: null, assignee: "u1" }] });
    expect(md).toContain("사람 속성 태스크");
  });

  it("프로젝트 매핑이 없으면 레슨은 개수만 남긴다", () => {
    const md = renderBrief({ ...base, projectId: null, projectName: null, projectStack: [] });
    expect(md.split("\n")[0]).toBe("# 워크스페이스: 팀 워크스페이스");
    expect(md).not.toContain("`cmproj");
    expect(md).toContain("전역 25건 — MCP lesson_list");
  });

  it("비어 있어도 깨지지 않는다", () => {
    const md = renderBrief({ ...base, lessons: [], tasks: [], counts: { docs: 0, decisions: 0, risks: 0, glossary: 0 } });
    expect(md).toContain("(열린 태스크 없음)");
    expect(md).toContain("MCP context_get");
  });
});
