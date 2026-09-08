import { NextResponse } from "next/server";
import { z } from "zod";
import { clearCompanionMemories, CompanionServiceError, deleteCompanionMemory, listCompanionMemories, updateCompanionMemory } from "@/lib/companion/service";
import { updateCompanionMemorySchema } from "@/lib/companion/schemas";
import {webError} from '@/lib/http/web-error';

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return NextResponse.json({ memories: await listCompanionMemories(new URL(request.url).searchParams.get("q") ?? "") });
}

export async function PATCH(request: Request) {
  const parsed = updateCompanionMemorySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "记忆修改参数无效", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ memory: await updateCompanionMemory(parsed.data) });
  } catch (error) {
    if (error instanceof CompanionServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return webError(error);
  }
}

const deleteSchema = z.object({ id: z.string().min(1).max(160).optional(), all: z.literal(true).optional() })
  .refine((value) => Boolean(value.id) !== Boolean(value.all), "必须且只能指定一条记忆或全部记忆");

export async function DELETE(request: Request) {
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "删除参数无效", issues: parsed.error.issues }, { status: 400 });
  try {
    if (parsed.data.all) return NextResponse.json({ deleted: await clearCompanionMemories() });
    await deleteCompanionMemory(parsed.data.id!);
    return NextResponse.json({ deleted: 1 });
  } catch (error) {
    if (error instanceof CompanionServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return webError(error);
  }
}
