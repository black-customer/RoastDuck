import { NextResponse } from "next/server";
import { trainingView } from "@/lib/four-step/training";
import { TrainingError } from "@/lib/four-step/shared";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json({ session: await trainingView((await params).id) }); }
  catch (error) { return NextResponse.json({ error: error instanceof TrainingError ? error.message : "无法读取训练，请重试" }, { status: error instanceof TrainingError ? error.status : 500 }); }
}
