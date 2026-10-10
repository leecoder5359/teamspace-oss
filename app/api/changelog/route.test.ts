import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { changelogEntry: { findMany: vi.fn(), create: vi.fn() } } }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), projectAccess: vi.fn() }));
vi.mock("@/lib/projectRef", () => ({ resolveProjectRef: vi.fn() }));

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, projectAccess } from "@/lib/pageGuard";
import { resolveProjectRef } from "@/lib/projectRef";
import { GET, POST } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };
const rows = [
  { id: "e1", projectId: null, title: "공용" },
  { id: "e2", projectId: "pOpen", title: "열림" },
  { id: "e3", projectId: "pSecret", title: "비공개" },
];
const post = (b: unknown) => new Request("http://t/api/changelog", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });

describe("/api/changelog 프로젝트별", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue(ctx);
    m(loadAccess).mockResolvedValue({ projects: new Map([["pOpen", {}], ["pSecret", {}]]) });
    m(projectAccess).mockImplementation((_i: unknown, p: string) => (p === "pSecret" ? "none" : p === "pView" ? "view" : "edit"));
    m(prisma.changelogEntry.findMany).mockResolvedValue(rows);
  });

  const OR = [{ projectId: null }, { projectId: { in: ["pOpen"] } }];

  it("GET 파라미터 없음 → where 에 허용 프로젝트만 넣어 take 전에 D3 필터(숨김 항목이 200건 자리를 먹지 않게)", async () => {
    await GET(new Request("http://t/api/changelog"));
    const arg = m(prisma.changelogEntry.findMany).mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId: "w1", OR });
    expect(arg.take).toBe(200);
  });

  it("GET ?project=<id> → projectId 로 필터", async () => {
    await GET(new Request("http://t/api/changelog?project=pOpen"));
    expect(m(prisma.changelogEntry.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", OR, projectId: "pOpen" });
  });

  it("GET ?project=none → projectId null 만", async () => {
    await GET(new Request("http://t/api/changelog?project=none"));
    expect(m(prisma.changelogEntry.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", OR, projectId: null });
  });

  it("GET ?project=<볼 수 없는 id> → where 가 모순이라 DB 에서 빈 목록", async () => {
    m(prisma.changelogEntry.findMany).mockResolvedValue([]);
    await GET(new Request("http://t/api/changelog?project=pSecret"));
    const w = m(prisma.changelogEntry.findMany).mock.calls[0][0].where;
    expect(w.projectId).toBe("pSecret");
    expect(w.OR).toEqual(OR); // pSecret 은 허용 목록 밖 → 어떤 행도 둘 다 만족 못 함
  });

  it("POST 볼 수 없는 프로젝트 → 400 '프로젝트를 찾을 수 없습니다.'(없는 프로젝트와 같은 문구), 저장 안 함", async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: "pSecret" });
    const res = await POST(post({ title: "t", projectId: "pSecret" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("프로젝트를 찾을 수 없습니다.");
    expect(prisma.changelogEntry.create).not.toHaveBeenCalled();
  });

  it("POST 보기 전용 프로젝트 → 400(같은 문구), 저장 안 함 — 쓰기는 edit 필요", async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: "pView" });
    const res = await POST(post({ title: "t", projectId: "pView" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("프로젝트를 찾을 수 없습니다.");
    expect(prisma.changelogEntry.create).not.toHaveBeenCalled();
  });

  it("POST projectId 를 resolveProjectRef 로 검증해 저장", async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: "pOpen" });
    m(prisma.changelogEntry.create).mockResolvedValue({ id: "n1" });
    const res = await POST(post({ title: "t", projectId: "pOpen" }));
    expect(res.status).toBe(200);
    expect(resolveProjectRef).toHaveBeenCalledWith("pOpen", "w1");
    expect(m(prisma.changelogEntry.create).mock.calls[0][0].data.projectId).toBe("pOpen");
  });

  it("POST 남의/없는 프로젝트 → 400, 저장 안 함", async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: false, err: NextResponse.json({ error: "x" }, { status: 400 }) });
    expect((await POST(post({ title: "t", projectId: "zzz" }))).status).toBe(400);
    expect(prisma.changelogEntry.create).not.toHaveBeenCalled();
  });

  it("POST projectId 생략 → null(공용)", async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: null });
    m(prisma.changelogEntry.create).mockResolvedValue({ id: "n1" });
    await POST(post({ title: "t" }));
    expect(m(prisma.changelogEntry.create).mock.calls[0][0].data.projectId).toBeNull();
  });
});
