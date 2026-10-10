import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { callbackPolicy } from "@/lib/llmjob";
import { checkCallbackUrl } from "@/lib/callbackUrl";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const ClassifyBody = z.object({
  kind: z.string().optional(),
  payload: z.unknown().optional(),
  callbackUrl: z.string().optional(),
  callbackSecret: z.string().optional(),
});

export const runtime = "nodejs";

const KINDS = new Set(["feedback_classify"]);

/** 비동기 LLM 잡 접수 — 즉시 202, 처리는 워커(dispatchLlmJobs)가 하고 결과는 callbackUrl 로 POST. */
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;

  const parsed = await readBody(request, ClassifyBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  if (!body.kind || !KINDS.has(body.kind)) return NextResponse.json({ error: "kind 가 없거나 지원하지 않음" }, { status: 400 });
  if (!body.payload || typeof body.payload !== "object") return NextResponse.json({ error: "payload 필요" }, { status: 400 });
  /* 콜백 URL 은 **접수 때 한 번, 발송 때 한 번** 본다(SSRF 축소, 피드백허브 후속).
     여기서만 막으면 이미 쌓인 행·다른 경로로 들어온 행이 그대로 나가고, 워커에서만
     막으면 실패가 로그에만 남아 부른 쪽이 잘못을 모른다. */
  const bad = checkCallbackUrl(body.callbackUrl || "", callbackPolicy());
  if (!bad.ok) return NextResponse.json({ error: bad.reason }, { status: 400 });

  const job = await prisma.llmJob.create({
    data: {
      workspaceId,
      kind: body.kind,
      payload: body.payload as object,
      callbackUrl: body.callbackUrl!,
      callbackSecret: body.callbackSecret || null,
    },
  });
  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
