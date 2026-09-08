import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { PageHeader } from "@/components/ui/PageHeader";

export const dynamic = "force-dynamic";

export default async function BookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDbReady();
  const books = await db.all<Record<string, unknown>>(sql`
    SELECT id, title_zh AS titleZh, title_en AS titleEn, status, blocked_reason AS blockedReason FROM books WHERE id = ${id} LIMIT 1`);
  if (books.length === 0) notFound();
  const topics = await db.all<Record<string, unknown>>(sql`
    SELECT t.id, t.name_zh AS nameZh, t.name_en AS nameEn, t.ielts_part AS part,
      (SELECT COUNT(*) FROM questions q WHERE q.topic_id = t.id) AS questionCount,
      (SELECT COUNT(DISTINCT c.id) FROM chunk_topic_links link JOIN chunks c ON c.id = link.chunk_id WHERE link.topic_id = t.id AND c.quality_status IN ('approved','edited')) AS chunkCount
    FROM topics t WHERE t.book_id = ${id} ORDER BY t.ielts_part, t.sort, t.id`);
  return (
    <div className="page-content">
      <PageHeader title={String(books[0].titleZh)} description={String(books[0].titleEn)} actions={<Link href="/books" className="secondary-button">返回词书</Link>} />
      {books[0].status === "blocked" ? <p className="book-blocked">{String(books[0].blockedReason || "缺少真实逐字稿，暂时不能学习。")}</p> : null}
      <div className="flex flex-col gap-2.5">
        {topics.map((t) => (
          <div key={t.id as string} className="page-panel flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-[var(--primary)]">
                P{t.part as number}
              </span>
              <span className="font-medium">{t.nameZh as string}</span>
              <span className="text-sm text-[var(--muted)]">{t.nameEn as string}</span>
            </div>
            <div className="text-sm text-[var(--muted)]">
              {t.questionCount as number} 题 · {t.chunkCount as number} 语块
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
