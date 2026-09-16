import { NextResponse } from "next/server";
import { validateBundle, SITE_LIMITS, type BundleFile } from "./bundle";

/* POST /api/sites · POST /api/sites/[id]/versions 공용 — requireCtx **다음에** 호출한다
   (본문을 읽기 전에 인증이 끝나야 한다: 이 경로는 미들웨어 matcher 밖이다). */
export async function readBundleUpload(req: Request): Promise<
  | { ok: true; form: FormData; files: BundleFile[]; sizeBytes: number; filename: string; skipped: { path: string; reason: string }[]; warnings: string[] }
  | { ok: false; res: NextResponse }
> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > SITE_LIMITS.uploadBytes + 1024 * 1024) {
    return { ok: false, res: NextResponse.json({ error: "파일이 너무 큽니다(최대 20MB)." }, { status: 413 }) };
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return { ok: false, res: NextResponse.json({ error: `multipart 본문을 읽지 못했습니다: ${e instanceof Error ? e.message : e}` }, { status: 400 }) };
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return { ok: false, res: NextResponse.json({ error: "file 필드(.html 또는 .zip)가 필요합니다." }, { status: 400 }) };
  }
  const data = Buffer.from(await file.arrayBuffer());
  const r = validateBundle({ filename: file.name, data });
  if (!r.ok) return { ok: false, res: NextResponse.json({ error: r.error }, { status: 400 }) };
  return { ok: true, form, files: r.files, sizeBytes: r.sizeBytes, filename: file.name, skipped: r.skipped, warnings: r.warnings };
}
