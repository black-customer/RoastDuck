import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 提交作答。POST /api/session/answer {chunkId, trainingType, rating, detail} */
export async function POST(req: Request) {
  void req;
  return NextResponse.json(
    { error: "旧版单题评分接口已停用；请使用 /api/learning/sessions/:id/events 完成整轮后结算。" },
    { status: 410 },
  );
}
