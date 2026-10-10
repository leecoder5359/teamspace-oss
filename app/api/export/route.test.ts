import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/exportService", () => ({ buildWorkspaceExport: vi.fn() }));

import { requireCtx } from "@/lib/workspace";
import { buildWorkspaceExport } from "@/lib/exportService";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;

describe("GET /api/export", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(buildWorkspaceExport).mockResolvedValue({ ok: true, zip: Buffer.from("PKzip"), stamp: "20261009-1200", filename: "내 워크스페이스-20261009.zip" });
  });

  it("editor 가드 — 실패하면 그대로 반환하고 zip 을 만들지 않는다", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    expect((await GET(new Request("http://t/api/export"))).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("editor");
    expect(buildWorkspaceExport).not.toHaveBeenCalled();
  });

  it("zip 응답 헤더: content-type·content-length·Content-Disposition(ASCII 폴백 + RFC 5987 한글 이름)", async () => {
    const res = await GET(new Request("http://t/api/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-length")).toBe("5");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain('attachment; filename="export-20261009-1200.zip"');
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent("내 워크스페이스-20261009.zip")}`);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("PKzip");
  });

  it("첨부는 기본 포함, ?attachments=0 이면 제외", async () => {
    await GET(new Request("http://t/api/export"));
    expect(m(buildWorkspaceExport).mock.calls[0][1]).toEqual({ withAttachments: true });
    await GET(new Request("http://t/api/export?attachments=0"));
    expect(m(buildWorkspaceExport).mock.calls[1][1]).toEqual({ withAttachments: false });
  });

  it("서비스 실패는 failResponse 로 변환", async () => {
    m(buildWorkspaceExport).mockResolvedValue({ ok: false, status: 500, error: "boom" });
    expect((await GET(new Request("http://t/api/export"))).status).toBe(500);
  });
});
