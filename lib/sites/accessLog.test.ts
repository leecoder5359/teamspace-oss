import { describe, it, expect } from "vitest";
import { summarizeAccess, shouldRecordAccess, ACCESS_DEDUPE_MS } from "./accessLog";

const at = (iso: string) => new Date(iso);

describe("summarizeAccess", () => {
  const rows = [
    { email: "g@gmail.com", member: false, version: 1, createdAt: at("2026-09-15T01:00:00Z") },
    { email: "g@gmail.com", member: false, version: 2, createdAt: at("2026-09-15T03:00:00Z") },
    { email: "m@team.com", member: true, version: 2, createdAt: at("2026-09-15T02:00:00Z") },
    { email: "old@gmail.com", member: false, version: 1, createdAt: at("2026-09-14T09:00:00Z") },
  ];

  it("계정별로 묶어 횟수·처음·마지막을 내고 마지막 열람 최신순으로 정렬한다", () => {
    const r = summarizeAccess(rows, ["g@gmail.com"]);
    expect(r.map((a) => a.email)).toEqual(["g@gmail.com", "m@team.com", "old@gmail.com"]);
    expect(r[0]).toMatchObject({ count: 2, firstAt: "2026-09-15T01:00:00.000Z", lastAt: "2026-09-15T03:00:00.000Z" });
  });

  it("구분: 지금 초대돼 있으면 invited, 멤버로 본 기록이면 member, 둘 다 아니면 revoked(초대 회수됨)", () => {
    const kinds = Object.fromEntries(summarizeAccess(rows, ["g@gmail.com"]).map((a) => [a.email, a.kind]));
    expect(kinds).toEqual({ "g@gmail.com": "invited", "m@team.com": "member", "old@gmail.com": "revoked" });
  });

  it("최근 기록은 최신순, 버전 포함, 상한까지만", () => {
    const r = summarizeAccess(rows, [], 1);
    expect(r[0].recent).toEqual([{ at: "2026-09-15T03:00:00.000Z", version: 2 }]);
  });

  it("기록이 없으면 빈 배열", () => {
    expect(summarizeAccess([], ["g@gmail.com"])).toEqual([]);
  });
});

describe("shouldRecordAccess", () => {
  const now = at("2026-09-15T03:00:00Z").getTime();
  it("직전 기록이 없거나 10분 넘었으면 남긴다, 안쪽이면 생략", () => {
    expect(shouldRecordAccess(null, now)).toBe(true);
    expect(shouldRecordAccess(new Date(now - ACCESS_DEDUPE_MS - 1), now)).toBe(true);
    expect(shouldRecordAccess(new Date(now - 60_000), now)).toBe(false);
  });
});
