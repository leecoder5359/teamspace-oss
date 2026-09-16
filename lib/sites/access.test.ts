import { describe, it, expect } from "vitest";
import { canViewSite, normalizeEmail, parseEmailList } from "./access";

const live = { status: "active" as const, deletedAt: null };

describe("canViewSite", () => {
  it("사이트가 없거나 삭제·비활성이면 멤버라도 not_found", () => {
    expect(canViewSite({ site: null, email: "a@x.com", invited: true, member: true })).toBe("not_found");
    expect(canViewSite({ site: { ...live, deletedAt: new Date() }, email: "a@x.com", invited: true, member: true })).toBe("not_found");
    expect(canViewSite({ site: { ...live, status: "disabled" }, email: "a@x.com", invited: true, member: true })).toBe("not_found");
  });
  it("초대받았거나 멤버면 ok", () => {
    expect(canViewSite({ site: live, email: "g@gmail.com", invited: true, member: false })).toBe("ok");
    expect(canViewSite({ site: live, email: "m@team.com", invited: false, member: true })).toBe("ok");
  });
  it("둘 다 아니거나 이메일이 없으면 forbidden", () => {
    expect(canViewSite({ site: live, email: "x@gmail.com", invited: false, member: false })).toBe("forbidden");
    expect(canViewSite({ site: live, email: null, invited: true, member: true })).toBe("forbidden");
  });
});

describe("normalizeEmail / parseEmailList", () => {
  it("trim·소문자화, 형식 불량은 null", () => {
    expect(normalizeEmail("  Guest@Gmail.COM ")).toBe("guest@gmail.com");
    expect(normalizeEmail("nope")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
  });
  it("쉼표·공백·줄바꿈·세미콜론으로 나누고 중복 제거", () => {
    expect(parseEmailList("a@x.com, B@x.com\nbad;a@X.com")).toEqual({ valid: ["a@x.com", "b@x.com"], invalid: ["bad"] });
    expect(parseEmailList(["a@x.com", "c@x.com d@x.com"]).valid).toEqual(["a@x.com", "c@x.com", "d@x.com"]);
  });
});
