import { NextResponse } from "next/server";
import { listPersonalBook } from "@/lib/answers/processor";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ book: await listPersonalBook() });
}
