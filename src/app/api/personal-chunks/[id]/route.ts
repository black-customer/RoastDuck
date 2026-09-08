import { NextResponse } from "next/server";
import { z } from "zod";
import { hidePersonalChunk, updatePersonalChunk } from "@/lib/answers/processor";

const updateSchema = z.object({
  display: z.string().trim().min(2).max(160),
  meaningZh: z.string().trim().min(1).max(300),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "个人 Chunk 修改内容不合法" }, { status: 400 });
  const result = await updatePersonalChunk(id, parsed.data);
  if (result === "not_found") return NextResponse.json({ error: "Chunk 不存在" }, { status: 404 });
  if (result === "public_chunk") return NextResponse.json({ error: "公共 Chunk 不能从个人词书修改；你可以移除个人关联。" }, { status: 409 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  await hidePersonalChunk(id);
  return NextResponse.json({ ok: true });
}
