import { expect, it } from "vitest";
import { runFourStepGolden } from "../pipeline/src/four-step-golden";
it("当前四步 Golden 逐条执行而非报告退役词书的虚假数量", () => {
  const result = runFourStepGolden();
  expect(result.ok).toBe(true);
  expect(result.checked).toBe(40);
  expect(new Set(result.results.map((r)=>r.id)).size).toBe(result.checked);
  expect(result.retiredBookGolden.executed).toBe(0);
});
