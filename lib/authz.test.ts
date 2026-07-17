import { describe, expect, it } from "vitest";
import { roleAtLeast, ROLE_ORDER } from "./authz";

describe("roleAtLeast", () => {
  it("viewer < editor < admin 서열을 강제한다", () => {
    expect(roleAtLeast("admin", "viewer")).toBe(true);
    expect(roleAtLeast("admin", "editor")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("editor", "viewer")).toBe(true);
    expect(roleAtLeast("editor", "editor")).toBe(true);
    expect(roleAtLeast("editor", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast("viewer", "admin")).toBe(false);
  });

  it("알 수 없는 역할은 항상 부족으로 판정한다(방어적)", () => {
    expect(roleAtLeast("ghost" as never, "viewer")).toBe(false);
  });

  it("ROLE_ORDER 가 세 역할을 모두 포함한다", () => {
    expect(Object.keys(ROLE_ORDER).sort()).toEqual(["admin", "editor", "viewer"]);
  });
});
