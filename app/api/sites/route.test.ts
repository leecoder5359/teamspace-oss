import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { createZip } from "@/lib/zip";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/sites/store", () => ({ writeVersion: vi.fn(), sitesRoot: () => "/tmp/sites" }));
vi.mock("@/lib/prisma", () => {
  const tx = {
    publishedSite: { create: vi.fn() },
    siteVersion: { create: vi.fn() },
    siteInvite: { createMany: vi.fn() },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      project: { findFirst: vi.fn() },
      publishedSite: { findMany: vi.fn() },
      __tx: tx,
    },
  };
});

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { writeVersion } from "@/lib/sites/store";
import { POST, GET } from "./route";

const m = (f: unknown) => f as Mock;
const tx = (prisma as unknown as { __tx: Record<string, Record<string, Mock>> }).__tx;
const ctx = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };

function upload(name: string, data: Buffer, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(data)]), name);
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new Request("http://t/api/sites", { method: "POST", body: form });
}

describe("POST /api/sites", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.$transaction).mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
  });

  it("인증 실패는 본문을 읽기 전에 그대로 반환", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 401 }) });
    const res = await POST(upload("a.html", Buffer.from("<p>")));
    expect(res.status).toBe(401);
    expect(requireCtx).toHaveBeenCalledWith("editor");
  });

  it("잘못된 번들은 400 + 이유", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    const res = await POST(upload("b.zip", createZip([{ path: "app.html", data: "<p>" }])));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("index.html");
  });

  it("html 업로드 → 사이트·v1·초대 생성, 파일 저장, 공개 URL 반환", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    tx.publishedSite.create.mockResolvedValue({ id: "cs1", slug: "SLUG", title: "보고서", status: "active", currentVersion: 1 });
    const res = await POST(upload("보고서.html", Buffer.from("<p>"), { invites: "g@gmail.com, bad" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toMatch(/\/s\/SLUG$/);
    expect(body.invites).toEqual({ added: ["g@gmail.com"], invalid: ["bad"] });
    expect(tx.siteVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ siteId: "cs1", version: 1, fileCount: 1 }) });
    expect(tx.siteInvite.createMany).toHaveBeenCalledWith({ data: [{ siteId: "cs1", email: "g@gmail.com", createdById: "u1" }], skipDuplicates: true });
    expect(writeVersion).toHaveBeenCalledWith("/tmp/sites", "cs1", 1, [expect.objectContaining({ path: "index.html" })]);
  });

  it("다른 워크스페이스 프로젝트는 400", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.project.findFirst).mockResolvedValue(null);
    const res = await POST(upload("a.html", Buffer.from("<p>"), { projectId: "pX" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sites", () => {
  beforeEach(() => vi.resetAllMocks());
  it("워크스페이스 사이트만, 삭제 제외로 조회", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findMany).mockResolvedValue([]);
    const res = await GET(new Request("http://t/api/sites"));
    expect(res.status).toBe(200);
    expect(m(prisma.publishedSite.findMany).mock.calls[0][0]).toMatchObject({ where: { workspaceId: "w1", deletedAt: null } });
  });
});
