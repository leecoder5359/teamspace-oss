// 순수 모듈은 vi.mock 없이 로드돼야 한다 — @/lib/prisma·@/lib/slack 이 평가되면 DB 연결이 필요해진다.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  KIND_META,
  alreadyDecidedModalResponse,
  buildApprovalCard,
  buildReasonModalView,
  buildResolvedCard,
  decisionSummary,
  formatKST,
  parseAlreadyDecided,
} from "./approvals.pure";

describe("approvals.pure 의존 경계", () => {
  it("prisma·slack·log 를 import 하지 않는다", () => {
    const src = readFileSync(new URL("./approvals.pure.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import\s.*from\s+["'](@\/lib\/(prisma|slack|log)|node:|\.\/(prisma|slack))/m);
    expect(src).not.toMatch(/\bfetch\(/);
  });
  it("export 목록이 명세와 같다", async () => {
    const pure = await import("./approvals.pure");
    expect(Object.keys(pure).sort()).toEqual(
      ["KIND_META", "alreadyDecidedModalResponse", "buildApprovalCard", "buildReasonModalView", "buildResolvedCard", "decisionSummary", "formatKST", "parseAlreadyDecided"],
    );
  });
});

describe("approvals.pure 동작", () => {
  it("decisionSummary", () => {
    expect(decisionSummary("approved")).toBe("✅ *승인됨*");
    expect(decisionSummary("rejected", "범위 밖")).toBe("✖ *거부됨* — 사유: 범위 밖");
    expect(decisionSummary("additional", "자료 추가")).toBe("✚ *추가 요청*: 자료 추가");
    expect(decisionSummary("pending")).toBe("⏳ 대기 중");
  });
  it("formatKST 는 Asia/Seoul 기준", () => {
    expect(formatKST(new Date("2026-10-09T15:30:00Z"))).toBe("2026-10-10 00:30");
  });
  it("parseAlreadyDecided / alreadyDecidedModalResponse", () => {
    expect(parseAlreadyDecided(new Error("already_decided:approved"))).toBe("approved");
    expect(parseAlreadyDecided(new Error("x"))).toBeNull();
    expect(parseAlreadyDecided("already_decided:approved")).toBeNull();
    expect(alreadyDecidedModalResponse("rejected").errors.reason).toContain("거부");
  });
  it("buildApprovalCard: 고위험은 빨간 색·배지, 긴 제목은 150자로 자른다", () => {
    const c = buildApprovalCard({ id: "a1", title: "x".repeat(300), body: "", kind: "deploy", highRisk: true });
    expect(c.attachments[0].color).toBe("#F0494E");
    const header = c.attachments[0].blocks[0] as unknown as { text: { text: string } };
    expect(header.text.text.length).toBe(150);
    expect(JSON.stringify(c.attachments[0].blocks)).toContain("고위험");
    expect(JSON.stringify(c.attachments[0].blocks)).toContain("_(내용 없음)_");
    expect(KIND_META.deploy.label).toBe("배포");
  });
  it("buildResolvedCard / buildReasonModalView", () => {
    const r = buildResolvedCard({ title: "T", body: "b", kind: "general" }, { status: "approved", responder: "me" });
    expect(r.text).toBe("T — ✅ *승인됨*");
    expect(r.attachments[0].color).toBe("#12B886");
    const m = buildReasonModalView({ approvalId: "a1", kind: "reject", title: "T" });
    expect(m.callback_id).toBe("approval_modal");
    expect(JSON.parse(m.private_metadata as string)).toEqual({ approvalId: "a1", kind: "reject" });
  });
});
