import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireCtx } from "@/lib/workspace";
import { uploadFileName } from "@/lib/assets";
import { uploadRoot } from "@/lib/uploadPaths";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";

const MAX_BYTES = 20 * 1024 * 1024; // 20MB

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
  // 이름 규칙은 lib/assets 로 모았다 — 가져오기(E4)가 첨부를 복원할 때 같은 규칙을 써야
  // 같은 파일이 두 번 늘어나지 않는다.
  const name = file.name.split("\\").pop() ?? file.name;
  const filename = uploadFileName(name, createHash("sha256").update(buf).digest("hex"));
  // 저장은 레포 밖(DATA_DIR/uploads) — public/ 은 빌드 산출물이라 런타임 파일을
  // 두면 배포에서 사라질 수 있고, 정적 서빙은 인증이 없다(OSS 후속).
  const dir = path.join(uploadRoot(), guard.workspaceId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), buf);

  const url = `/uploads/${guard.workspaceId}/${encodeURIComponent(filename)}`;
  const isImage = /^image\//.test(file.type);
  const markdown = isImage ? `![${name}](${url})` : `[${name}](${url})`;

  recordActivity(guard, "uploaded", "file", name);
  return NextResponse.json({ ok: true, url, markdown, size: file.size });
}
