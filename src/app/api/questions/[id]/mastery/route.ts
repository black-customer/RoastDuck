import { NextResponse } from "next/server";
import { z } from "zod";
import { setQuestionMastery } from "@/lib/questions/service";

const masteryInputSchema = z.object({
  mastered: z.boolean().optional(),
  completedFourStep: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const json = await request.json().catch(() => ({}));
  const parsed = masteryInputSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "掌握状态参数不合法" }, { status: 400 });
  }
  const { id } = await params;
  if (parsed.data.completedFourStep !== undefined) {
    return NextResponse.json({ error: "强化完成必须由服务端训练会话验证，不能手动提交", code: "server_verified_completion_required" }, { status: 409 });
  }
  if (typeof parsed.data.mastered === "boolean") {
    const result = await setQuestionMastery(id, parsed.data.mastered);
    return NextResponse.json(result);
  }
  return NextResponse.json({ error: "缺少有效参数" }, { status: 400 });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return POST(request, context);
}
