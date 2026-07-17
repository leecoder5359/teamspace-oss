import { describe, it, expect } from "vitest";
import { GET } from "./route";

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

describe("GET /api/setup/hooks/[name]", () => {
  it("화이트리스트 외 이름 → 404", async () => {
    const res = await GET(new Request("http://t"), ctx("evil"));
    expect(res.status).toBe(404);
  });
  it("경로탈출(../) → 404", async () => {
    const res = await GET(new Request("http://t"), ctx("../secret"));
    expect(res.status).toBe(404);
  });
  it("허용된 훅(.mjs 접미사 허용) → 200 + JS content-type", async () => {
    const res = await GET(new Request("http://t"), ctx("deny-repo-docs.mjs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("javascript");
  });
});
