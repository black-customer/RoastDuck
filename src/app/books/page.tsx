import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDbReady } from "@db/client";
import { PageHeader } from "@/components/ui/PageHeader";

export const dynamic = "force-dynamic";

export default async function BooksPage() {
  const db = await getDbReady();
  const books = await db.all<Record<string, unknown>>(sql`
    SELECT b.id, b.title_zh AS titleZh, b.title_en AS titleEn, b.source_type AS sourceType,
      b.description_zh AS descriptionZh, b.status, b.blocked_reason AS blockedReason,
      (SELECT COUNT(*) FROM chunks c WHERE c.book_id = b.id AND c.quality_status != 'rejected') AS chunkCount,
      (SELECT COUNT(*) FROM questions q WHERE q.book_id = b.id) AS questionCount,
      (SELECT COUNT(*) FROM topics t WHERE t.book_id = b.id) AS topicCount,
      (SELECT COUNT(*) FROM learning_progress lp JOIN chunks c ON c.id = lp.chunk_id
        WHERE c.book_id = b.id AND lp.intro_done = 1) AS learnedCount,
      (SELECT COUNT(*) FROM learning_progress lp JOIN chunks c ON c.id = lp.chunk_id
        WHERE c.book_id = b.id AND lp.mastery = 'mastered') AS masteredCount
    FROM books b ORDER BY b.id`);
  return (
    <div className="page-content">
      <PageHeader title="词书" description="按来源浏览表达。词书保留完整材料，每天只安排一小部分学习。" />
      <div className="book-list">
        {books.map((book) => {
          const blocked = book.status === "blocked" || (book.sourceType === "podcast" && Number(book.chunkCount) === 0);
          return <article key={String(book.id)} className="book-row">
            <div>
              <h2>{String(book.titleZh)}</h2>
              <p>{String(book.descriptionZh ?? "")}</p>
              <div className="book-row-meta">
                <span>{book.sourceType === "podcast" ? "播客" : book.sourceType === "personal_answers" ? "个人回答" : "雅思题库"}</span>
                <span>{Number(book.chunkCount)} 个表达</span><span>{Number(book.learnedCount)} 个已学</span>
              </div>
              {blocked ? <div className="book-blocked">材料暂缺 · {String(book.blockedReason || "缺少真实逐字稿，暂时不能学习。")}</div> : null}
            </div>
            <div className="book-row-actions"><Link className="secondary-button" href={book.sourceType === "personal_answers" ? "/personal-book" : `/books/${encodeURIComponent(String(book.id))}`}>{blocked ? "查看材料状态" : "打开词书"}</Link></div>
          </article>;
        })}
      </div>
    </div>
  );
}
