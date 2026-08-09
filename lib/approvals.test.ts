import { describe, it, expect } from "vitest";
import { buildApprovalCard, buildResolvedCard, decisionSummary, KIND_META, formatKST, buildReasonModalView } from "@/lib/approvals";

describe("buildApprovalCard", () => {
  const full = buildApprovalCard({
    id: "ap_1", title: "프로덕션 배포", body: "main→prod", kind: "deploy", highRisk: true,
    requesterName: "이호준", projectName: "iOS앱", createdAt: new Date("2026-07-01T05:30:00Z"),
  });

  it("highRisk=빨강 액센트 + 고위험 배지", () => {
    expect(full.attachments[0].color).toBe("#F0494E");
    expect(JSON.stringify(full.attachments[0].blocks)).toContain("고위험");
  });

  it("header(제목+이모지)·본문·메타 포함", () => {
    const s = JSON.stringify(full.attachments[0].blocks);
    expect(s).toContain("🚀 프로덕션 배포");
    expect(s).toContain("main→prod");
    expect(s).toContain("이호준");
    expect(s).toContain("iOS앱");
    expect(s).toContain("2026-07-01 14:30");
  });

  it("3버튼 action_id·value 보존", () => {
    const actions = full.attachments[0].blocks.find((b) => b.type === "actions") as
      | { type: string; elements: { action_id: string; value: string }[] }
      | undefined;
    expect(actions).toBeTruthy();
    expect(actions!.elements.map((e) => e.action_id)).toEqual(["approve", "additional", "reject"]);
    for (const e of actions!.elements) expect(e.value).toBe("ap_1");
  });

  it("메타 없음 → 메타 context 생략, 일반=파랑", () => {
    const min = buildApprovalCard({ id: "ap_2", title: "t", body: "", kind: "general", highRisk: false });
    expect(min.attachments[0].color).toBe("#2F62FF");
    expect(JSON.stringify(min.attachments[0].blocks)).toContain("_(내용 없음)_");
    expect(JSON.stringify(min.attachments[0].blocks)).not.toContain("👤");
  });

  it("text 폴백 문구", () => {
    expect(full.text).toBe("승인 요청: 프로덕션 배포");
  });
});

describe("decisionSummary", () => {
  it("상태별 결과 문구", () => {
    expect(decisionSummary("approved")).toContain("승인");
    expect(decisionSummary("rejected", "사유X")).toContain("거부");
    expect(decisionSummary("rejected", "사유X")).toContain("사유X");
    expect(decisionSummary("additional", "더 해주세요")).toContain("추가 요청");
  });
});

describe("KIND_META", () => {
  it("deploy=🚀/배포/빨강, general=📋/일반/파랑", () => {
    expect(KIND_META.deploy).toEqual({ emoji: "🚀", label: "배포", color: "#F0494E" });
    expect(KIND_META.general).toEqual({ emoji: "📋", label: "일반", color: "#2F62FF" });
  });
});

describe("formatKST", () => {
  it("UTC를 KST YYYY-MM-DD HH:mm 로", () => {
    expect(formatKST(new Date("2026-07-01T05:30:00Z"))).toBe("2026-07-01 14:30");
  });
});

describe("buildResolvedCard", () => {
  it("approved=초록 + 결과 라인(응답자·시각)", () => {
    const c = buildResolvedCard(
      { title: "배포", body: "b", kind: "deploy" },
      { status: "approved", responder: "이호준", at: new Date("2026-07-01T05:32:00Z") },
    );
    expect(c.attachments[0].color).toBe("#12B886");
    const s = JSON.stringify(c.attachments[0].blocks);
    expect(s).toContain("승인됨");
    expect(s).toContain("이호준");
    expect(s).toContain("14:32");
  });
  it("rejected=빨강 + 사유, additional=회색", () => {
    expect(buildResolvedCard({ title: "t", body: "", kind: "general" }, { status: "rejected", responseText: "이유" }).attachments[0].color).toBe("#F0494E");
    expect(JSON.stringify(buildResolvedCard({ title: "t", body: "", kind: "general" }, { status: "rejected", responseText: "이유" }))).toContain("이유");
    expect(buildResolvedCard({ title: "t", body: "", kind: "general" }, { status: "additional", responseText: "더" }).attachments[0].color).toBe("#9AA3AF");
  });
});

describe("header 150자 truncate", () => {
  it("150자 초과 제목 → buildApprovalCard header ≤150자", () => {
    const longTitle = "가".repeat(200);
    const card = buildApprovalCard({ id: "ap_trunc", title: longTitle, body: "", kind: "general", highRisk: false });
    const header = card.attachments[0].blocks.find((b) => b.type === "header") as
      | { type: string; text: { type: string; text: string } }
      | undefined;
    expect(header).toBeTruthy();
    expect(header!.text.text.length).toBeLessThanOrEqual(150);
  });
});

describe("buildReasonModalView", () => {
  const v = buildReasonModalView({ approvalId: "ap_1", kind: "reject", title: "배포" }) as Record<string, unknown>;
  it("callback_id·private_metadata·reason input 보존", () => {
    expect(v.callback_id).toBe("approval_modal");
    expect(JSON.parse(v.private_metadata as string)).toEqual({ approvalId: "ap_1", kind: "reject" });
    const input = (v.blocks as Record<string, unknown>[]).find((b) => b.block_id === "reason") as Record<string, unknown>;
    const element = input.element as Record<string, unknown>;
    expect(element.action_id).toBe("value");
    expect(element.multiline).toBe(true);
  });
  it("원본 제목을 context로 노출", () => {
    expect(JSON.stringify(v.blocks)).toContain("배포");
  });
});
