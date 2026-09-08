import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@db/client";

export const dynamic = "force-dynamic";

/** 词书列表与进度。GET /api/books */
export async function GET() {
  const db = getDb();
  const books = await db.all<Record<string, unknown>>(sql`
    SELECT b.id, b.title_zh AS titleZh, b.title_en AS titleEn, b.source_type AS sourceType,
      b.description_zh AS descriptionZh,
      (SELECT COUNT(*) FROM chunks c WHERE c.book_id = b.id AND c.quality_status != 'rejected') AS chunkCount,
      (SELECT COUNT(*) FROM questions q WHERE q.book_id = b.id) AS questionCount,
      (SELECT COUNT(*) FROM learning_progress lp JOIN chunks c ON c.id = lp.chunk_id
        WHERE c.book_id = b.id AND lp.intro_done = 1) AS learnedCount,
      (SELECT COUNT(*) FROM learning_progress lp JOIN chunks c ON c.id = lp.chunk_id
        WHERE c.book_id = b.id AND lp.mastery = 'mastered') AS masteredCount
    FROM books b ORDER BY b.id`);
  return NextResponse.json({ books });
}
