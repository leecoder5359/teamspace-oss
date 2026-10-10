import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readBody, positionSchema, idSchema } from "./apiBody";

const mk = (body?: string) => new Request("http://x/api", { method: "POST", body });

describe("readBody", () => {
  it("깨진 JSON → 400 문구", async () => {
    const r = await readBody(mk("{oops"), z.object({}));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.res.status).toBe(400);
    expect(await r.res.json()).toEqual({ error: "본문이 올바른 JSON 이 아닙니다." });
  });

  it("빈 본문 + 전부 optional → ok", async () => {
    const r = await readBody(mk(""), z.object({ a: z.string().optional() }));
    expect(r).toEqual({ ok: true, data: {} });
    const r2 = await readBody(mk(undefined), z.object({ a: z.string().optional() }));
    expect(r2.ok).toBe(true);
  });

  it("스키마 실패 → issues path/message", async () => {
    const r = await readBody(mk(JSON.stringify({ position: null })), z.object({ position: positionSchema.optional() }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.res.status).toBe(400);
    const j = await r.res.json();
    expect(j.error).toBe("입력값이 올바르지 않습니다.");
    expect(j.issues[0].path).toBe("position");
    expect(typeof j.issues[0].message).toBe("string");
  });

  it("성공 시 data 는 strip 된 값", async () => {
    const r = await readBody(mk(JSON.stringify({ a: "x", extra: 1 })), z.object({ a: z.string() }));
    expect(r).toEqual({ ok: true, data: { a: "x" } });
  });

  it("positionSchema·idSchema 경계", () => {
    expect(positionSchema.safeParse(0).success).toBe(true);
    for (const v of [-1, 1.5, "1", null]) expect(positionSchema.safeParse(v).success).toBe(false);
    expect(idSchema.safeParse("").success).toBe(false);
    expect(idSchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});
