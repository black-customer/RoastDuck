import { NextResponse } from "next/server";
import { getMaterial } from "@/lib/four-step/materials";
import { TrainingError } from "@/lib/four-step/shared";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const material = await getMaterial((await params).id);
    // 状态查询不发送未进入揭示阶段的标准答案，也不触发网络任务。
    return NextResponse.json({ id: material.id, status: material.status, error: material.status === "failed" ? "材料生成或独立审核未通过，原回答已保留。请返回回答页重试。" : null });
  } catch (error) { return NextResponse.json({ error: error instanceof TrainingError ? error.message : "材料暂不可用" }, { status: error instanceof TrainingError ? error.status : 500 }); }
}
