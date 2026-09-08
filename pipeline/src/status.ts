/** 流水线进度总览：npm run pipeline:status */
import { sql } from "drizzle-orm";
import { getDbReady } from "../../db/client";

async function main() {
  const db = await getDbReady();
  const r = await db.all<{
    books: number;
    topics: number;
    questions: number;
    questions_blueprint: number;
    sentences: number;
    sentences_pending: number;
    sentences_chunked: number;
    sentences_covered: number;
    sentences_no_new_unit: number;
    chunks: number;
    chunks_approved: number;
  }>(sql`
    SELECT
      (SELECT COUNT(*) FROM books) AS books,
      (SELECT COUNT(*) FROM topics) AS topics,
      (SELECT COUNT(*) FROM questions) AS questions,
      (SELECT COUNT(*) FROM questions WHERE status != 'pending') AS questions_blueprint,
      (SELECT COUNT(*) FROM source_sentences) AS sentences,
      (SELECT COUNT(*) FROM source_sentences WHERE status = 'pending') AS sentences_pending,
      (SELECT COUNT(*) FROM source_sentences WHERE status = 'chunked') AS sentences_chunked,
      (SELECT COUNT(*) FROM source_sentences WHERE status = 'covered') AS sentences_covered,
      (SELECT COUNT(*) FROM source_sentences WHERE status = 'no_new_unit') AS sentences_no_new_unit,
      (SELECT COUNT(*) FROM chunks) AS chunks,
      (SELECT COUNT(*) FROM chunks WHERE quality_status = 'approved') AS chunks_approved
  `);
  const row = r[0];
  console.log("=== 鱼块学英语 流水线状态 ===");
  console.log(`词书:            ${row.books}`);
  console.log(`话题:            ${row.topics}`);
  console.log(`题目:            ${row.questions}（已有蓝图: ${row.questions_blueprint}）`);
  console.log(
    `示范答案句:      ${row.sentences}（pending=${row.sentences_pending} chunked=${row.sentences_chunked} covered=${row.sentences_covered} no_new_unit=${row.sentences_no_new_unit}）`,
  );
  console.log(`语块:            ${row.chunks}（approved=${row.chunks_approved}）`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
