import { NextResponse } from "next/server";
import { createOrGetCompanionThread, listCompanionThreads, CompanionServiceError } from "@/lib/companion/service";
import { createCompanionThreadSchema } from "@/lib/companion/schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ threads: await listCompanionThreads() });
}

export async function POST(request: Request) {
  const parsed = createCompanionThreadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Chloe 线程参数无效", issues: parsed.error.issues }, { status: 400 });
  try {
    return NextResponse.json({ thread: await createOrGetCompanionThread(parsed.data) }, { status: 201 });
  } catch (error) {
    if (error instanceof CompanionServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    throw error;
  }
}
