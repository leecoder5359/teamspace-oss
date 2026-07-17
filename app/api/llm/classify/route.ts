import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

const KINDS = new Set(["feedback_classify"]);

/** 비동기 LLM 잡 접수 — 즉시 202, 처리는 워커(dispatchLlmJobs)가 하고 결과는 callbackUrl 로 POST. */
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;

  const body = (await request.json().catch(() => ({}))) as {
    kind?: string; payload?: unknown; callbackUrl?: string; callbackSecret?: string;
  };
  if (!body.kind || !KINDS.has(body.kind)) return NextResponse.json({ error: "kind 가 없거나 지원하지 않음" }, { status: 400 });
  if (!body.payload || typeof body.payload !== "object") return NextResponse.json({ error: "payload 필요" }, { status: 400 });
  if (!/^https?:\/\//.test(body.callbackUrl || "")) return NextResponse.json({ error: "callbackUrl 은 http(s) URL" }, { status: 400 });

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
