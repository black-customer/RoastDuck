import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@db/client";

export const dynamic = "force-dynamic";

/** 单个语块详情。GET /api/chunks/[id] */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const chunks = await db.all<Record<string, unknown>>(sql`
    SELECT c.id, c.display_chunk AS display, c.canonical_chunk AS canonical, c.unit_type AS unitType,
      c.meaning_zh AS meaningZh, c.english_gloss AS englishGloss, c.pattern,
      c.variants_json AS variantsJson, c.tags_json AS tagsJson, c.difficulty, c.quality_status AS qualityStatus,
      t.name_zh AS topicName, t.name_en AS topicNameEn
    FROM chunks c LEFT JOIN topics t ON t.id = c.topic_id
    WHERE c.id = ${id} LIMIT 1`);
  if (chunks.length === 0) return NextResponse.json({ error: "not found" }, { status: 404 });
  const chunk = chunks[0];
  const examples = await db.all<Record<string, unknown>>(sql`
    SELECT text_en AS en, text_zh AS zh, is_source_sentence AS isSource, source_ref AS sourceRef
    FROM chunk_examples WHERE chunk_id = ${id} ORDER BY is_source_sentence DESC, sort`);
  const sources = await db.all<Record<string, unknown>>(sql`
    SELECT source_type AS sourceType, question_id AS questionId, source_context AS context
    FROM chunk_sources WHERE chunk_id = ${id}`);
  const questions = await db.all<Record<string, unknown>>(sql`
    SELECT q.id, q.text, q.part FROM questions q
    JOIN chunk_coverage_refs r ON r.question_id = q.id
    WHERE r.chunk_id = ${id} LIMIT 5`);
  return NextResponse.json({ chunk, examples, sources, questions });
}
