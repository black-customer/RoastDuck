import { NextResponse } from "next/server";
import { applyTrainingEvent } from "@/lib/four-step/training";
import { trainingEventSchema } from "@/lib/four-step/contracts";
import { TrainingError } from "@/lib/four-step/shared";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = trainingEventSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "训练事件格式无效" }, { status: 400 });
  try { return NextResponse.json({ session: await applyTrainingEvent((await params).id, parsed.data) }); }
  catch (error) { return NextResponse.json({ error: error instanceof TrainingError ? error.message : "训练服务暂不可用，输入已保留", code: error instanceof TrainingError ? error.code : "training_unavailable" }, { status: error instanceof TrainingError ? error.status : 500 }); }
}
