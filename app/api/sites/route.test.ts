import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { createZip } from "@/lib/zip";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/sites/store", () => ({ writeVersion: vi.fn(), sitesRoot: () => "/tmp/sites" }));
vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: vi.fn(),
    publishedSite: { create: vi.fn(), findUnique: vi.fn() },
    siteSlugAlias: { findUnique: vi.fn() },
    siteVersion: { create: vi.fn() },
    siteInvite: { createMany: vi.fn() },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      project: { findFirst: vi.fn() },
      publishedSite: { findMany: vi.fn(), findUnique: vi.fn() },
      siteSlugAlias: { findUnique: vi.fn() },
      __tx: tx,
    },
  };
});

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { writeVersion } from "@/lib/sites/store";
import { POST, GET } from "./route";
import { SITE_SLUG_LOCK_KEY } from "@/lib/sites/slug";

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

describe("POST /api/sites — slug(설명형 주소)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.$transaction).mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    m(requireCtx).mockResolvedValue(ctx);
    tx.publishedSite.create.mockImplementation(async ({ data }: { data: { slug: string } }) => ({ id: "cs1", slug: data.slug, title: "T", status: "active", currentVersion: 1 }));
  });

  it("지정한 slug 로 만들고 url 도 그 주소", async () => {
    const res = await POST(upload("a.html", Buffer.from("<p>"), { slug: "banjang-handover" }));
    expect(res.status).toBe(201);
    expect(tx.publishedSite.create.mock.calls[0][0].data.slug).toBe("banjang-handover");
    expect((await res.json()).url).toMatch(/\/s\/banjang-handover$/);
  });

  it("slug 미지정이면 무작위 12자", async () => {
    await POST(upload("a.html", Buffer.from("<p>")));
    expect(tx.publishedSite.create.mock.calls[0][0].data.slug).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("형식이 틀리면 400, 만들지 않음", async () => {
    for (const bad of ["Banjang", "a", "api", "한글"]) {
      const res = await POST(upload("a.html", Buffer.from("<p>"), { slug: bad }));
      expect(res.status, bad).toBe(400);
    }
    expect(tx.publishedSite.create).not.toHaveBeenCalled();
  });

  it("다른 사이트의 현재 주소·옛 주소면 409", async () => {
    m(prisma.publishedSite.findUnique).mockResolvedValueOnce({ id: "other" });
    let res = await POST(upload("a.html", Buffer.from("<p>"), { slug: "taken-slug" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("이미 쓰고 있는 주소");
    m(prisma.siteSlugAlias.findUnique).mockResolvedValueOnce({ siteId: "other" });
    res = await POST(upload("a.html", Buffer.from("<p>"), { slug: "old-alias" }));
    expect(res.status).toBe(409);
    expect(tx.publishedSite.create).not.toHaveBeenCalled();
  });

  it("지정 slug 는 트랜잭션 안에서 advisory 락을 잡고 다시 검사한 뒤 만든다", async () => {
    const res = await POST(upload("a.html", Buffer.from("<p>"), { slug: "locked-slug" }));
    expect(res.status).toBe(201);
    const exec = m(tx.$executeRaw);
    const lockCall = exec.mock.calls[0];
    expect(lockCall[0].join("?")).toContain("pg_advisory_xact_lock");
    expect(lockCall[1]).toBe(SITE_SLUG_LOCK_KEY);
    const order = (f: Mock) => f.mock.invocationCallOrder[0];
    expect(order(exec)).toBeLessThan(order(tx.publishedSite.findUnique));
    expect(order(exec)).toBeLessThan(order(tx.siteSlugAlias.findUnique));
    expect(order(tx.siteSlugAlias.findUnique)).toBeLessThan(order(tx.publishedSite.create));
  });

  it("락 안의 재검사에서 다른 사이트 별칭으로 잡혀 있으면 409, 만들지 않음", async () => {
    tx.siteSlugAlias.findUnique.mockResolvedValueOnce({ siteId: "other" });
    const res = await POST(upload("a.html", Buffer.from("<p>"), { slug: "raced-alias" }));
    expect(res.status).toBe(409);
    expect(tx.publishedSite.create).not.toHaveBeenCalled();
  });

  it("무작위 slug 는 락을 잡지 않는다", async () => {
    await POST(upload("a.html", Buffer.from("<p>")));
    expect(m(tx.$executeRaw)).not.toHaveBeenCalled();
  });

  it("검사 뒤 동시에 잡힌 경우(P2002)도 409", async () => {
    tx.publishedSite.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await POST(upload("a.html", Buffer.from("<p>"), { slug: "race-slug" }));
    expect(res.status).toBe(409);
  });
});

describe("GET /api/sites", () => {
  beforeEach(() => vi.resetAllMocks());
  it("옛 주소(aliases)를 문자열 배열로 돌려준다", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findMany).mockResolvedValue([
      { id: "cs1", slug: "new-one", title: "T", status: "active", currentVersion: 1, projectId: null, apiUpstream: null, updatedAt: new Date(), invites: [], aliases: [{ slug: "OLDrandom123" }] },
    ]);
    const body = await (await GET(new Request("http://t/api/sites"))).json();
    expect(body.sites[0]).toMatchObject({ slug: "new-one", aliases: ["OLDrandom123"] });
    expect(body.sites[0].url).toMatch(/\/s\/new-one$/);
  });
  it("워크스페이스 사이트만, 삭제 제외로 조회", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findMany).mockResolvedValue([]);
    const res = await GET(new Request("http://t/api/sites"));
    expect(res.status).toBe(200);
    expect(m(prisma.publishedSite.findMany).mock.calls[0][0]).toMatchObject({ where: { workspaceId: "w1", deletedAt: null } });
  });
});
