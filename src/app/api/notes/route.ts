import { NextResponse } from "next/server";
import { z } from "zod";
import { createDifficultyNoteFromAnnotation, listNotes, upsertDifficultyNote } from "@/lib/learning/content";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const chunkIds = params.getAll("chunkId").filter(Boolean).slice(0, 30);
  return NextResponse.json({ notes: await listNotes(chunkIds.length ? chunkIds : undefined) });
}

const createNoteSchema = z
  .object({
    annotationId: z.string().min(1).max(120).optional(),
    chunkId: z.string().min(1).max(120).optional(),
    surface: z.string().min(1).max(200).optional(),
    meaningZh: z.string().max(300).optional(),
    trigger: z.string().min(1).max(60).default("user_added"),
  })
  .refine((value) => Boolean(value.annotationId) || Boolean(value.chunkId && value.surface), {
    message: "需要 annotationId，或同时提供 chunkId 与 surface",
  });

export async function POST(request: Request) {
  const parsed = createNoteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "请求体不合法", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  if (input.annotationId) {
    const note = await createDifficultyNoteFromAnnotation(input.annotationId, input.trigger);
    if (!note) return NextResponse.json({ error: "未找到该英文注解" }, { status: 404 });
    return NextResponse.json({ note }, { status: 201 });
  }
  const note = await upsertDifficultyNote({
    chunkId: input.chunkId ?? null,
    surface: input.surface ?? "",
    meaningZh: input.meaningZh ?? "",
    sourceType: "chunk",
    sourceId: input.chunkId ?? "",
    trigger: input.trigger,
  });
  return NextResponse.json({ note }, { status: 201 });
}
