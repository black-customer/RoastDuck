import { NextResponse } from "next/server";
import { getSpeakingAttempt } from "@/lib/speaking-practice/service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const attempt = await getSpeakingAttempt(id);
    if (!attempt) {
      return NextResponse.json({ error: "未找到答题记录" }, { status: 404 });
    }
    return NextResponse.json({ attempt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取答题记录失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
