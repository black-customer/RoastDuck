import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDbReady } from "@db/client";
import { aiJobs } from "@db/schema";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getDbReady();
  const [job] = await db.select({
    id: aiJobs.id,
    kind: aiJobs.kind,
    status: aiJobs.status,
    attempts: aiJobs.attempts,
    lastErrorCode: aiJobs.lastErrorCode,
    createdAt: aiJobs.createdAt,
    updatedAt: aiJobs.updatedAt,
  }).from(aiJobs).where(eq(aiJobs.id, id)).limit(1);
  if (!job) return NextResponse.json({ error: "AI 任务不存在" }, { status: 404 });
  return NextResponse.json({ job });
}
