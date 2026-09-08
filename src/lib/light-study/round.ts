import { z } from "zod";

/** Platform-neutral learning sequence. No database, clock, network, or FSRS side effects. */
export const lightRatingSchema = z.enum(["remembered", "uncertain", "forgot"]);
export type LightRating = z.infer<typeof lightRatingSchema>;
export type LightPhase = "initial" | "consolidation";
const occurrence = z.object({ sourceIndex: z.number().int().min(0).max(4), phase: z.enum(["initial", "consolidation"]) }).strict();
export const lightRoundSchema = z.object({
  initialCount: z.number().int().min(1).max(5),
  queue: z.array(occurrence).min(1).max(8),
  cursor: z.number().int().min(0).max(8),
  revealed: z.boolean(),
  consolidationPlanned: z.boolean(),
  assessments: z.array(occurrence.extend({ rating: lightRatingSchema, position: z.number().int().min(0).max(7) })).max(8),
}).strict().refine(round => round.cursor <= round.queue.length && round.queue.every(item => item.sourceIndex < round.initialCount), "Invalid light-study cursor or source");
export type LightRound = z.infer<typeof lightRoundSchema>;

export function createLightRound(count: number): LightRound {
  return lightRoundSchema.parse({ initialCount: count, queue: Array.from({ length: count }, (_, sourceIndex) => ({ sourceIndex, phase: "initial" })), cursor: 0, revealed: false, consolidationPlanned: false, assessments: [] });
}

export function revealLightRound(round: LightRound): LightRound {
  if (!round.queue[round.cursor]) throw new Error("本组已经结束");
  return { ...round, revealed: true };
}

function interveningExpressions(history: number[], sourceIndex: number) {
  const origin = history.lastIndexOf(sourceIndex);
  return origin < 0 ? 0 : new Set(history.slice(origin + 1).filter(value => value !== sourceIndex)).size;
}

/** Recheck actual encounters: an invalid/skipped planned card cannot count as learning. */
export function consolidationIsEligible(round: LightRound): boolean {
  const item = round.queue[round.cursor];
  return !!item && (item.phase === "initial" || interveningExpressions(round.assessments.map(value => value.sourceIndex), item.sourceIndex) >= 3);
}

export function advanceLightRound(round: LightRound, rating: LightRating | null): LightRound {
  const item = round.queue[round.cursor];
  if (!item) throw new Error("本组已经结束");
  if (rating && !round.revealed) throw new Error("先揭晓表达，再评价刚才是否想起来");
  if (rating && !consolidationIsEligible(round)) throw new Error("间隔不足，暂不重复这项表达");
  const next = structuredClone(round);
  if (rating) next.assessments.push({ ...item, rating, position: round.cursor });
  next.cursor++;
  next.revealed = false;
  if (!next.consolidationPlanned && next.cursor === next.initialCount) {
    next.consolidationPlanned = true;
    const priority = { forgot: 0, uncertain: 1, remembered: 2 };
    const candidates = next.assessments.filter(value => value.phase === "initial" && value.rating !== "remembered")
      .sort((a, b) => priority[a.rating] - priority[b.rating] || a.position - b.position);
    const history = next.assessments.map(value => value.sourceIndex);
    for (let count = 0; count < 3; count++) {
      const index = candidates.findIndex(value => interveningExpressions(history, value.sourceIndex) >= 3);
      if (index < 0) break; // Never insert filler or force an immediate repetition.
      const [candidate] = candidates.splice(index, 1);
      next.queue.push({ sourceIndex: candidate.sourceIndex, phase: "consolidation" });
      history.push(candidate.sourceIndex);
    }
  }
  return next;
}

export function initialWasAssessed(round: LightRound, sourceIndex: number) {
  return round.assessments.some(value => value.sourceIndex === sourceIndex && value.phase === "initial");
}
