import { sql } from "drizzle-orm";
import { getDbReady } from "@db/client";

export interface GapOutputMasteryEvidence {
  status: "learning" | "resolved";
  independentDates: string[];
  completedDueReview: boolean;
  latestSessionConfirmedError: boolean;
}

/**
 * 输出掌握与 FSRS 调度分开计算：FSRS 决定何时复习，这里只判断是否已有跨日独立使用证据。
 * 看过答案后的 active/repair 提取不计入；同一会话、同一天也不会重复累计。
 */
export async function refreshGapOutputMastery(gapId: string): Promise<GapOutputMasteryEvidence> {
  const db = await getDbReady();
  const sessions = await db.all<{
    sessionId: string;
    localDate: string;
    lastAt: string;
    independentInitial: number;
    independentTransfer: number;
    independentReview: number;
    confirmedOpeningError: number;
  }>(sql`
    SELECT session_id AS sessionId,local_date AS localDate,MAX(created_at) AS lastAt,
      MAX(CASE WHEN phase='initial' AND verdict='natural_equivalent' AND assistance_level=0 THEN 1 ELSE 0 END) AS independentInitial,
      MAX(CASE WHEN phase IN ('transfer','transfer_retry') AND verdict='natural_equivalent' AND assistance_level=0 THEN 1 ELSE 0 END) AS independentTransfer,
      MAX(CASE WHEN phase='review' AND verdict='natural_equivalent' AND assistance_level=0 THEN 1 ELSE 0 END) AS independentReview,
      MAX(CASE WHEN phase IN ('initial','review') AND verdict='incorrect' THEN 1 ELSE 0 END) AS confirmedOpeningError
    FROM retrieval_attempts WHERE gap_id=${gapId}
    GROUP BY session_id,local_date ORDER BY lastAt DESC,sessionId DESC`);

  const independentDates = [...new Set(sessions
    .filter((session) => session.independentReview === 1 || (session.independentInitial === 1 && session.independentTransfer === 1 && session.confirmedOpeningError === 0))
    .map((session) => session.localDate))].sort();
  const completedDueReview = sessions.some((session) => session.independentReview === 1 && session.confirmedOpeningError === 0);
  const latestSessionConfirmedError = sessions[0]?.confirmedOpeningError === 1;
  const status = independentDates.length >= 2 && completedDueReview && !latestSessionConfirmedError ? "resolved" : "learning";
  await db.run(sql`UPDATE answer_gaps SET status=${status},updated_at=${new Date().toISOString()}
    WHERE id=${gapId} AND learning_fit=1 AND status IN ('open','learning','resolved')`);
  return { status, independentDates, completedDueReview, latestSessionConfirmedError };
}
