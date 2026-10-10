import { NextResponse } from "next/server";
import { z } from "zod";

export type BodyResult<T> = { ok: true; data: T } | { ok: false; res: NextResponse };

/**
 * 본문을 JSON 으로 읽고 schema 로 검증한다. 빈 본문은 {} 로 본다(모두 optional 인 스키마는 통과).
 * JSON 깨짐 → 400 {error:"본문이 올바른 JSON 이 아닙니다."}
 * 스키마 실패 → 400 {error:"입력값이 올바르지 않습니다.", issues:[{path:"position", message}]}
 * 스키마에 없는 필드는 무시(strip)한다.
 */
export async function readBody<S extends z.ZodType>(req: Request, schema: S): Promise<BodyResult<z.infer<S>>> {
  let raw: unknown = {};
  const text = await req.text().catch(() => "");
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, res: NextResponse.json({ error: "본문이 올바른 JSON 이 아닙니다." }, { status: 400 }) };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return {
      ok: false,
      res: NextResponse.json({ error: "입력값이 올바르지 않습니다.", issues }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}

export const idSchema = z.string().min(1).max(64);
export const positionSchema = z.number().int().min(0).max(1_000_000_000);
