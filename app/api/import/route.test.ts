import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/importService", () => ({ importZip: vi.fn(), MAX_BYTES: 50 * 1024 * 1024 }));

import { requireCtx } from "@/lib/workspace";
import { importZip } from "@/lib/importService";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "editor" };

function req(opts: { query?: string; fields?: Record<string, string>; file?: boolean; headers?: Record<string, string> } = {}) {
  const fd = new FormData();
  if (opts.file !== false) fd.set("file", new File([new Uint8Array([80, 75, 3, 4])], "a.zip", { type: "application/zip" }));
  for (const [k, v] of Object.entries(opts.fields ?? {})) fd.set(k, v);
  return new Request(`http://t/api/import${opts.query ?? ""}`, { method: "POST", body: fd, headers: opts.headers });
}

describe("POST /api/import", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue(ctx);
    m(importZip).mockResolvedValue({ ok: true, dryRun: false, created: 1 });
  });

  it("인증 실패는 본문을 읽지 않고 그대로 반환", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    expect((await POST(req())).status).toBe(403);
    expect(importZip).not.toHaveBeenCalled();
  });

  it("?dryRun=1 쿼리로 드라이런", async () => {
    await POST(req({ query: "?dryRun=1" }));
    expect(m(importZip).mock.calls[0][1].dryRun).toBe(true);
  });

  it("폼 필드 dryRun=true/on 도 드라이런", async () => {
    await POST(req({ fields: { dryRun: "true" } }));
    expect(m(importZip).mock.calls[0][1].dryRun).toBe(true);
    await POST(req({ fields: { dryRun: "on" } }));
    expect(m(importZip).mock.calls[1][1].dryRun).toBe(true);
  });

  it("dryRun 이 없거나 0/false 면 실행 모드", async () => {
    await POST(req());
    await POST(req({ query: "?dryRun=0", fields: { dryRun: "false" } }));
    expect(m(importZip).mock.calls[0][1].dryRun).toBe(false);
    expect(m(importZip).mock.calls[1][1].dryRun).toBe(false);
  });

  it("폼 옵션(createProjects·skipExisting·projectId)을 넘긴다(앞뒤 공백 제거)", async () => {
    await POST(req({ fields: { createProjects: "1", skipExisting: "true", projectId: "  p1  " } }));
    const o = m(importZip).mock.calls[0][1];
    expect(o).toMatchObject({ createProjects: true, skipExisting: true, projectRef: "p1" });
  });

  it("content-length 가 한도(+1MB 여유)를 넘으면 본문을 읽기 전에 413", async () => {
    const res = await POST(req({ headers: { "content-length": String(50 * 1024 * 1024 + 1024 * 1024 + 1) } }));
    expect(res.status).toBe(413);
    expect(importZip).not.toHaveBeenCalled();
  });

  it("file 필드가 없으면 400", async () => {
    const res = await POST(req({ file: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("file 필드");
  });

  it("서비스 실패는 failResponse 로 변환", async () => {
    m(importZip).mockResolvedValue({ ok: false, status: 422, error: "zip 아님" });
    const res = await POST(req());
    expect(res.status).toBe(422);
  });
});
