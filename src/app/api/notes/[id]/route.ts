import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDbReady } from "@db/client";
import { difficultNotes } from "@db/schema";

export const dynamic = "force-dynamic";

const patchNoteSchema = z
  .object({
    userRemark: z.string().max(2000).optional(),
    status: z.enum(["open", "resolved"]).optional(),
  })
  .refine((value) => value.userRemark !== undefined || value.status !== undefined, "至少更新一个字段");

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = patchNoteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "笔记参数无效", issues: parsed.error.issues }, { status: 400 });
  const { id } = await params;
  const db = await getDbReady();
  const existing = await db.select().from(difficultNotes).where(eq(difficultNotes.id, id)).limit(1);
  if (!existing[0]) return NextResponse.json({ error: "笔记不存在" }, { status: 404 });
  await db
    .update(difficultNotes)
    .set({ ...parsed.data, updatedAt: new Date().toISOString() })
    .where(eq(difficultNotes.id, id));
  const [note] = await db.select().from(difficultNotes).where(eq(difficultNotes.id, id)).limit(1);
  return NextResponse.json({ note });
}
