import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// 잠금 이름 정규형(2026-10-10): 철자가 달라도 같은 자원이면 같은 잠금 — 잡기·해제·조회 모두.
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(), pushNotification: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { pushLock: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() } },
}));

import { prisma } from "@/lib/prisma";
import { canonicalLockName } from "./pushLockRules";
import { getLock, releaseLock, resolveName, takeLock, LockError } from "./pushLock";
import { canonicalLockName as hookCanonical, lockNameFor } from "../scripts/hooks/git-pre-push.mjs";
import { checkName } from "../scripts/wsLock";

const m = (f: unknown) => f as Mock;
const pl = prisma.pushLock as unknown as Record<string, Mock>;
const now = new Date("2026-10-10T10:00:00Z");
const ctx = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "agent", id: "u1", name: "mac-mini" } } as never;
const row = (over: Record<string, unknown> = {}) => ({
  id: "l1", name: "teamspace/main", holderName: "laptop", holderUserId: "u2", holderSession: null, cwd: null, branch: null, note: null,
  takenAt: new Date(now.getTime() - 5 * 60000), expiresAt: new Date(now.getTime() + 25 * 60000), releasedAt: null, ...over,
});

describe("canonicalLockName", () => {
  it.each([
    ["teamspace-main", "teamspace/main"],
    ["teamspace/main", "teamspace/main"],
    ["TeamSpace_main", "teamspace/main"],
    ["  teamspace :: main  ", "teamspace/main"],
    ["deploy:teamspace", "deploy/teamspace"],
    ["/banjang//develop/", "banjang/develop"],
    ["a.b_c-d e", "a/b/c/d/e"],
  ])("%j → %s", (raw, want) => expect(canonicalLockName(raw)).toBe(want));
  it("훅 사본도 같은 결과", () => {
    for (const s of ["teamspace-main", "TeamSpace_main", "deploy:teamspace", "x.y z"]) expect(hookCanonical(s)).toBe(canonicalLockName(s));
    expect(lockNameFor("teamspace", "feature_x")).toBe("teamspace/feature/x");
  });
  it("CLI 도 정규형으로 보낸다", () => {
    expect(checkName("TeamSpace_main")).toBe("teamspace/main");
    expect(() => checkName("한글/main")).toThrow(/형식/);
    expect(() => checkName("  ")).toThrow(/필요/);
  });
});

describe("resolveName", () => {
  beforeEach(() => vi.resetAllMocks());

  it("정규형 행이 살아 있으면 정규형", async () => {
    pl.findUnique.mockResolvedValue(row());
    expect(await resolveName("w1", "TeamSpace-Main", now)).toBe("teamspace/main");
    expect(pl.findUnique.mock.calls[0][0]).toMatchObject({ where: { workspaceId_name: { workspaceId: "w1", name: "teamspace/main" } } });
    expect(pl.findMany).not.toHaveBeenCalled();
  });

  it("정규형 행이 없고 옛 철자 행이 살아 있으면 그 행 이름", async () => {
    pl.findUnique.mockResolvedValue(null);
    pl.findMany.mockResolvedValue([{ name: "banjang-develop" }, { name: "teamspace-main" }]);
    expect(await resolveName("w1", "teamspace/main", now)).toBe("teamspace-main");
  });

  it("맞는 옛 행이 없으면 정규형", async () => {
    pl.findUnique.mockResolvedValue(row({ releasedAt: now }));
    pl.findMany.mockResolvedValue([{ name: "banjang-develop" }]);
    expect(await resolveName("w1", "teamspace_main", now)).toBe("teamspace/main");
  });

  it("정규형이 규칙 밖이면 400", async () => {
    await expect(resolveName("w1", "한글/main", now)).rejects.toBeInstanceOf(LockError);
  });
});

describe("철자가 달라도 서로 배제한다", () => {
  beforeEach(() => vi.resetAllMocks());

  it("남이 teamspace/main 을 잡았으면 teamspace-main 으로 잡기는 409", async () => {
    pl.findUnique.mockResolvedValue(row());
    pl.updateMany.mockResolvedValue({ count: 0 });
    const err = await takeLock(ctx, "teamspace-main", {}, now).catch((e) => e);
    expect(err).toBeInstanceOf(LockError);
    expect((err as LockError).status).toBe(409);
    for (const c of pl.updateMany.mock.calls) expect(c[0].where.name).toBe("teamspace/main");
    expect(pl.create).not.toHaveBeenCalled();
  });

  it("빈 이름이면 정규형으로 새 행을 만든다", async () => {
    pl.findUnique.mockResolvedValue(null);
    pl.findMany.mockResolvedValue([]);
    pl.updateMany.mockResolvedValue({ count: 0 });
    pl.create.mockResolvedValue({});
    pl.findUniqueOrThrow.mockResolvedValue(row({ holderName: "mac-mini", holderUserId: "u1" }));
    const r = await takeLock(ctx, "TeamSpace_main", {}, now);
    expect(m(pl.create).mock.calls[0][0].data.name).toBe("teamspace/main");
    expect(r).toMatchObject({ result: "taken", lock: { name: "teamspace/main", mine: true } });
  });

  it("옛 철자로 남이 잡은 행도 정규형 잡기를 막고, 응답 이름은 정규형", async () => {
    pl.findUnique.mockImplementation(async ({ where }: { where: { workspaceId_name: { name: string } } }) =>
      where.workspaceId_name.name === "teamspace-main" ? row({ name: "teamspace-main" }) : null,
    );
    pl.findMany.mockResolvedValue([{ name: "teamspace-main" }]);
    pl.updateMany.mockResolvedValue({ count: 0 });
    const err = (await takeLock(ctx, "teamspace/main", {}, now).catch((e) => e)) as LockError;
    expect(err.status).toBe(409);
    expect((err.extra.lock as { name: string }).name).toBe("teamspace/main");
    expect(pl.create).not.toHaveBeenCalled();
  });

  it("해제·조회도 정규형(또는 살아 있는 옛 행)으로 찾는다", async () => {
    pl.findUnique.mockResolvedValue(row({ holderName: "mac-mini", holderUserId: "u1" }));
    pl.updateMany.mockResolvedValue({ count: 1 });
    expect(await releaseLock(ctx, "TEAMSPACE-MAIN", {}, now)).toEqual({ released: true, forced: false });
    expect(pl.updateMany.mock.calls[0][0].where.name).toBe("teamspace/main");

    vi.resetAllMocks();
    pl.findUnique.mockImplementation(async ({ where }: { where: { workspaceId_name: { name: string } } }) =>
      where.workspaceId_name.name === "teamspace-main" ? row({ name: "teamspace-main" }) : null,
    );
    pl.findMany.mockResolvedValue([{ name: "teamspace-main" }]);
    const g = await getLock(ctx, "teamspace/main", null, now);
    expect(g.lock).toMatchObject({ name: "teamspace/main", holderName: "laptop", active: true });
  });
});
