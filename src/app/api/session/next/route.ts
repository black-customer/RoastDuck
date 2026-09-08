import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 取下一个学习/复习条目。GET /api/session/next?mode=learn|review */
export async function GET(req: Request) {
  void req;
  return NextResponse.json(
    { error: "旧版无状态接口已停用；请使用 POST /api/learning/sessions 创建或恢复会话。" },
    { status: 410 },
  );
}
