import { NextResponse } from "next/server";
import { z } from "zod";
import { createTraining } from "@/lib/four-step/training";
import { TrainingError } from "@/lib/four-step/shared";

export async function POST(request: Request) {
  const parsed = z.object({ materialId: z.string().min(1).max(120), mode: z.enum(["learn", "review"]).default("learn") }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "训练参数无效" }, { status: 400 });
  try { return NextResponse.json({ session: await createTraining(parsed.data.materialId, parsed.data.mode) }); }
  catch (error) { return NextResponse.json({ error: error instanceof TrainingError ? error.message : "训练服务暂不可用", code: error instanceof TrainingError ? error.code : "training_unavailable" }, { status: error instanceof TrainingError ? error.status : 500 }); }
}
