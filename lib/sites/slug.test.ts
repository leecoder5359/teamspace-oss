import { describe, it, expect, vi } from "vitest";
import { checkSlug, slugTaken, changeSiteSlug, isUniqueViolation, RESERVED_SLUGS, SITE_SLUG_LOCK_KEY } from "./slug";

describe("checkSlug", () => {
  it("영문 소문자·숫자·하이픈(단어 사이) 3~60자를 받는다", () => {
    for (const ok of ["abc", "banjang-handover", "v2-report-2026", "a1b", "x".repeat(60)]) {
      expect(checkSlug(ok), ok).toEqual({ ok: true, slug: ok });
    }
    expect(checkSlug("  banjang-handover ")).toEqual({ ok: true, slug: "banjang-handover" });
  });

  it("형식이 틀리면 거절", () => {
    for (const bad of ["ab", "x".repeat(61), "Banjang", "한글주소", "a_b", "a--b", "-ab", "ab-", "a b", "a/b", "a.b", "../x", ""]) {
      const r = checkSlug(bad);
      expect(r.ok, bad).toBe(false);
    }
    expect(checkSlug(123).ok).toBe(false);
    expect(checkSlug(null).ok).toBe(false);
  });

  it("예약어 거절", () => {
    for (const r of ["api", "pub", "new", "admin", "login"]) {
      // 3자 미만(s 등)은 길이에서 먼저 막힌다 — 어느 쪽이든 거절이면 된다.
      expect(checkSlug(r).ok, r).toBe(false);
    }
    expect(RESERVED_SLUGS.has("s")).toBe(true);
    const r = checkSlug("admin");
    expect(!r.ok && r.error).toContain("예약");
  });
});

function db(opts: { site?: { id: string } | null; alias?: { siteId: string } | null } = {}) {
  return {
    $executeRaw: vi.fn(),
    publishedSite: { findUnique: vi.fn().mockResolvedValue(opts.site ?? null), update: vi.fn() },
    siteSlugAlias: { findUnique: vi.fn().mockResolvedValue(opts.alias ?? null), deleteMany: vi.fn(), create: vi.fn() },
  };
}
type Db = Parameters<typeof changeSiteSlug>[0];

describe("slugTaken — 현재 슬러그와 별칭 전체에서 유일", () => {
  it("아무도 안 쓰면 false", async () => {
    expect(await slugTaken(db() as unknown as Db, "free-slug")).toBe(false);
  });
  it("다른 사이트의 현재 슬러그면 true", async () => {
    expect(await slugTaken(db({ site: { id: "other" } }) as unknown as Db, "x-y", "me")).toBe(true);
  });
  it("다른 사이트의 옛 슬러그(별칭)여도 true", async () => {
    expect(await slugTaken(db({ alias: { siteId: "other" } }) as unknown as Db, "x-y", "me")).toBe(true);
    expect(await slugTaken(db({ alias: { siteId: "other" } }) as unknown as Db, "x-y")).toBe(true);
  });
  it("자기 사이트의 별칭·현재 슬러그는 충돌이 아니다", async () => {
    expect(await slugTaken(db({ alias: { siteId: "me" } }) as unknown as Db, "x-y", "me")).toBe(false);
    expect(await slugTaken(db({ site: { id: "me" } }) as unknown as Db, "x-y", "me")).toBe(false);
  });
});

describe("changeSiteSlug", () => {
  it("옛 슬러그를 별칭으로 남기고, 새 슬러그가 자기 별칭이면 그 별칭을 지운다", async () => {
    const d = db({ alias: { siteId: "me" } });
    const r = await changeSiteSlug(d as unknown as Db, { id: "me", slug: "OLDrandom123" }, "banjang-handover");
    expect(r).toBe("changed");
    expect(d.siteSlugAlias.deleteMany).toHaveBeenCalledWith({ where: { slug: "banjang-handover", siteId: "me" } });
    expect(d.publishedSite.update).toHaveBeenCalledWith({ where: { id: "me" }, data: { slug: "banjang-handover" } });
    expect(d.siteSlugAlias.create).toHaveBeenCalledWith({ data: { slug: "OLDrandom123", siteId: "me" } });
  });
  it("검사 전에 슬러그 advisory 락을 잡는다", async () => {
    const d = db();
    await changeSiteSlug(d as unknown as Db, { id: "me", slug: "OLDrandom123" }, "new-name");
    expect(d.$executeRaw.mock.calls[0][0].join("?")).toContain("pg_advisory_xact_lock");
    expect(d.$executeRaw.mock.calls[0][1]).toBe(SITE_SLUG_LOCK_KEY);
    expect(d.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(d.siteSlugAlias.findUnique.mock.invocationCallOrder[0]);
    expect(d.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(d.publishedSite.findUnique.mock.invocationCallOrder[0]);
  });
  it("같은 슬러그면 아무것도 안 한다", async () => {
    const d = db();
    expect(await changeSiteSlug(d as unknown as Db, { id: "me", slug: "same-one" }, "same-one")).toBe("same");
    expect(d.publishedSite.update).not.toHaveBeenCalled();
  });
  it("남의 것이면 taken, 쓰기 없음", async () => {
    const d = db({ alias: { siteId: "other" } });
    expect(await changeSiteSlug(d as unknown as Db, { id: "me", slug: "a-b-c" }, "taken-one")).toBe("taken");
    expect(d.publishedSite.update).not.toHaveBeenCalled();
    expect(d.siteSlugAlias.create).not.toHaveBeenCalled();
  });
});

it("isUniqueViolation 은 P2002 만", () => {
  expect(isUniqueViolation({ code: "P2002" })).toBe(true);
  expect(isUniqueViolation({ code: "P2025" })).toBe(false);
  expect(isUniqueViolation(new Error("x"))).toBe(false);
});
