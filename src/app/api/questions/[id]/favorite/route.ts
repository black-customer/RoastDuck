import { NextResponse } from "next/server";
import { favoriteInputSchema } from "@/lib/questions/schemas";
import { setQuestionFavorite } from "@/lib/questions/service";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = favoriteInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "收藏参数不合法" }, { status: 400 });
  const { id } = await params;
  const favorite = await setQuestionFavorite(id, parsed.data.favorite);
  if (favorite == null) return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  return NextResponse.json({ favorite });
}
