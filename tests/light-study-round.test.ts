import { expect, it } from "vitest";
import { advanceLightRound, consolidationIsEligible, createLightRound, revealLightRound, type LightRound, type LightRating } from "../src/lib/light-study/round";
const rate = (round: LightRound, rating: LightRating) => advanceLightRound(revealLightRound(round), rating);

it("both modes can use a five-item hidden-answer sequence; reveal and rating are separate", () => {
  const round = createLightRound(5);
  expect(round.revealed).toBe(false);
  expect(() => advanceLightRound(round, "remembered")).toThrow("先揭晓");
  expect(revealLightRound(round).assessments).toHaveLength(0);
  for (const count of [0, 6]) expect(() => createLightRound(count)).toThrow();
});
it("all remembered ends without adding practice and transitions do not mutate saved snapshots", () => {
  const original = createLightRound(5);
  let round = original;
  for (let index = 0; index < 5; index++) round = rate(round, "remembered");
  expect(round.cursor).toBe(5); expect(round.queue).toHaveLength(5);
  expect(original.cursor).toBe(0); expect(original.assessments).toHaveLength(0);
});
it("at most three weak items reappear once; forgot first among eligible candidates", () => {
  let round = createLightRound(5);
  for (const rating of ["uncertain", "forgot", "forgot", "forgot", "forgot"] as const) round = rate(round, rating);
  expect(round.queue.slice(5)).toEqual([
    { sourceIndex: 1, phase: "consolidation" },
    { sourceIndex: 2, phase: "consolidation" },
    { sourceIndex: 3, phase: "consolidation" },
  ]);
  while (round.cursor < round.queue.length) {
    expect(consolidationIsEligible(round)).toBe(true);
    round = rate(round, "forgot");
  }
  expect(round.assessments).toHaveLength(8); expect(round.queue).toHaveLength(8);
});
it("too few intervening expressions never force a repetition or filler", () => {
  let round = createLightRound(3);
  for (let index = 0; index < 3; index++) round = rate(round, "forgot");
  expect(round.queue).toHaveLength(3);
});
it("invalid items do not count as encounters; skipping a repetition rechecks the next interval", () => {
  let round = createLightRound(5);
  for (let index = 0; index < 5; index++) round = rate(round, "forgot");
  round = advanceLightRound(round, null); // planned source 0 never encountered again
  expect(consolidationIsEligible(round)).toBe(true); // source 1 still has three original others
  round = advanceLightRound(round, null);
  expect(consolidationIsEligible(round)).toBe(false); // source 2 has only two real intervening others
  round = advanceLightRound(round, null);
  expect(round.cursor).toBe(round.queue.length);
});
