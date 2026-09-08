import { NextResponse } from "next/server";
import { getQuestionLearningPack } from "@/lib/questions/learning-pack-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pack = await getQuestionLearningPack(id);
  if (!pack) return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  return NextResponse.json({ pack });
}
