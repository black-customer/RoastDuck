import { NextResponse } from "next/server";
import { amendChunk } from "@/lib/content/amendments";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDbReady } from "@db/client";

export const dynamic = "force-dynamic";

/** Content Review：抽查列表。GET /api/review-content?status=pending_review&limit=30 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "pending_review";
  const parsedLimit = z.coerce.number().int().min(1).max(100).safeParse(searchParams.get("limit") ?? 30);
  if (!["pending_review", "approved", "edited", "rejected"].includes(status) || !parsedLimit.success) {
    return NextResponse.json({ error: "筛选参数无效" }, { status: 400 });
  }
  const limit = parsedLimit.data;
  const db = await getDbReady();
  const rows = await db.all<Record<string, unknown>>(sql`
    SELECT c.id, c.display_chunk AS display, c.meaning_zh AS meaningZh, c.unit_type AS unitType,
      c.difficulty, c.quality_status AS qualityStatus, c.reject_reason AS rejectReason,
      (SELECT e.text_en FROM chunk_examples e WHERE e.chunk_id = c.id LIMIT 1) AS exampleEn
    FROM chunks c
    WHERE c.quality_status = ${status}
    ORDER BY c.created_at DESC LIMIT ${limit}`);
  return NextResponse.json({ items: rows });
}

/** 用户编辑与隐藏，不承担独立 Reviewer 的审批权限。 */
const reviewActionSchema = z.object({
  id: z.string().min(3),
  action: z.enum(["approve", "reject", "edit"]),
  fields: z.object({ displayChunk: z.string().trim().min(1).max(300).optional(), meaningZh: z.string().trim().min(1).max(1000).optional() }).strict().optional(),
  reason: z.string().max(300).optional(),
});

export async function POST(req: Request) {
  const parsed = reviewActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "审核参数无效", issues: parsed.error.issues }, { status: 400 });
  const body = parsed.data;
  if (body.action === "approve") {
    return NextResponse.json({ error: "内容需经过独立自动审核，不能在此直接发布。", code: "independent_review_required" }, { status: 409 });
  }
  if (body.action === "reject" && !body.reason?.trim()) {
    return NextResponse.json({ error: "拒绝必须填写具体原因" }, { status: 400 });
  }
  if (body.action === "edit" && !body.fields?.displayChunk && !body.fields?.meaningZh) {
    return NextResponse.json({ error: "请提供要修改的表达或中文意思" }, { status: 400 });
  }
  const result = await amendChunk({ id: body.id, action: body.action, fields: body.fields, reason: body.reason });
  if (!result) return NextResponse.json({ error: "没有找到该表达" }, { status: 404 });
  return NextResponse.json({ ok: true, ...result });
}
