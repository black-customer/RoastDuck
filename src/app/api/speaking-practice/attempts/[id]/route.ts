import { NextResponse } from "next/server";
import { webError } from "@/lib/http/web-error";
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
    return webError(error);
  }
}
