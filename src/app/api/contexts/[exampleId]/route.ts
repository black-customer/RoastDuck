import { NextResponse } from "next/server";
import { getExampleContext } from "@/lib/learning/content";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ exampleId: string }> }) {
  const { exampleId } = await params;
  const context = await getExampleContext(exampleId);
  if (!context) return NextResponse.json({ error: "例句上下文不存在" }, { status: 404 });
  return NextResponse.json(context);
}
