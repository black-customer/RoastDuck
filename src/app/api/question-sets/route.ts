import { NextResponse } from "next/server";
import { listQuestionSets } from "@/lib/questions/service";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ sets: await listQuestionSets() });
}
