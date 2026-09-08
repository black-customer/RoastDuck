import { NextResponse } from "next/server";
import { getAiHealth } from "@/lib/ai/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getAiHealth(), {
    headers: { "cache-control": "no-store" },
  });
}
