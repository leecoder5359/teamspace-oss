import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";

const MAX_BYTES = 20 * 1024 * 1024; // 20MB
const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

// 파일명 안전화: 경로 구분자·제어문자 제거, 길이 제한
function safeName(name: string): string {
  const base = name.split("/").pop()!.split("\\").pop()!.replace(/[\x00-\x1f:*?"<>|]/g, "_").trim() || "file";
  return base.slice(0, 120);
}

// POST /api/upload (multipart form-data, field: file) → 로컬 디스크 저장 (W6 inv-12)
// 응답: { url, markdown } — 문서 본문에 붙여넣어 사용. 이미지면 ![..](url) 형태.
export async function POST(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "multipart form-data 의 file 필드가 필요합니다." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "20MB 를 초과합니다." }, { status: 413 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const name = safeName(file.name);
  const dir = path.join(UPLOAD_ROOT, guard.workspaceId);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${hash}-${name}`;
  await fs.writeFile(path.join(dir, filename), buf);

  const url = `/uploads/${guard.workspaceId}/${encodeURIComponent(filename)}`;
  const isImage = /^image\//.test(file.type);
  const markdown = isImage ? `![${name}](${url})` : `[${name}](${url})`;

  recordActivity(guard, "uploaded", "file", name);
  return NextResponse.json({ ok: true, url, markdown, size: file.size });
}
