import { describe, it, expect } from "vitest";
import { TEMPLATES, TEMPLATE_NAMES, renderTemplate, isTemplateName } from "./docTemplates";

describe("docTemplates", () => {
  it.each(TEMPLATE_NAMES)("%s 는 제목·템플릿 줄을 포함한다", (n) => {
    const md = renderTemplate(n, "내 문서", "2026-10-09");
    expect(md.startsWith("# 내 문서\n")).toBe(true);
    expect(md).toContain("> 템플릿: " + n + " · 2026-10-09");
  });
  it("docType 매핑", () => {
    expect(TEMPLATES.design.docType).toBe("design");
    expect(TEMPLATES.plan.docType).toBe("plan");
    expect(TEMPLATES.report.docType).toBe("report");
    expect(TEMPLATES.handoff.docType).toBe("handoff");
  });
  it("design 은 mermaid, plan 은 검증 열", () => {
    expect(renderTemplate("design", "t", "d")).toContain("```mermaid\nflowchart");
    expect(renderTemplate("plan", "t", "d")).toContain("| 태스크 | 담당 | 검증 |");
  });
  it("design 은 mermaid 자리표시 주석, plan 은 (태스크) 셀, handoff 는 상태 힌트", () => {
    expect(renderTemplate("design", "t", "d")).toContain("%% 흐름을 여기에 그리세요");
    expect(renderTemplate("plan", "t", "d")).toContain("| (태스크) |");
    expect(renderTemplate("handoff", "t", "d")).toMatch(/## 상태\n\n- \(진행 중/);
  });
  it.each(TEMPLATE_NAMES)("%s 목록 표기는 '- ' 하나로 통일한다", (n) => {
    const md = renderTemplate(n, "t", "d");
    expect(md).not.toMatch(/^[*+] /m);
    expect(md).not.toMatch(/^\d+[.)] /m);
  });
  it("모든 템플릿이 H1 하나·빈 H2 없이 시작 구조를 가진다", () => {
    for (const n of TEMPLATE_NAMES) {
      const md = renderTemplate(n, "t", "d");
      expect(md.match(/^# /gm)).toHaveLength(1);
      expect(md.match(/^## /gm)!.length).toBeGreaterThanOrEqual(4);
    }
  });
  it("isTemplateName", () => {
    expect(isTemplateName("plan")).toBe(true);
    expect(isTemplateName("toString")).toBe(false);
    expect(isTemplateName(3)).toBe(false);
  });
});
