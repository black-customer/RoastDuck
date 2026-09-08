import { NextResponse } from "next/server";
import { getSpeakingSession } from "@/lib/speaking/service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getSpeakingSession(id);
  if (!session) return NextResponse.json({ error: "输出会话不存在" }, { status: 404 });
  return NextResponse.json({ session });
}
