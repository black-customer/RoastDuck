import { NextResponse } from "next/server";
import { openLookup } from "@/lib/learning/content";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ annotationId: string }> }) {
  const { annotationId } = await params;
  const lookup = await openLookup(annotationId);
  if (!lookup) return NextResponse.json({ error: "英文注解不存在" }, { status: 404 });
  return NextResponse.json(lookup);
}
