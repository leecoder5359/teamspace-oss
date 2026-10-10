import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const OnboardingBody = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
});

export const runtime = "nodejs";

export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const steps = await prisma.onboardingStep.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], take: 200 });
  return NextResponse.json({ steps });
}

export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const parsed = await readBody(request, OnboardingBody);
  if (!parsed.ok) return parsed.res;
  const b = parsed.data;
  const title = b.title?.trim();
  if (!title) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  const last = await prisma.onboardingStep.findFirst({ where: { workspaceId }, orderBy: { position: "desc" }, select: { position: true } });
  const created = await prisma.onboardingStep.create({ data: { workspaceId, title, body: b.body?.trim() || null, position: (last?.position ?? -1) + 1 } });
  return NextResponse.json({ id: created.id });
}
