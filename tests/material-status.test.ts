import {expect,it} from "vitest";
import {materialFailureMessage} from "@/lib/four-step/material-status";
it("格式、引用、超时分开解释，不把错误源内容直接下发",()=>{
  expect(materialFailureMessage("material_ai_timeout")).toContain("超时");
  expect(materialFailureMessage("material_ai_invalid_output")).toContain("格式");
  expect(materialFailureMessage("material_source_quote")).toContain("引用");
  expect(materialFailureMessage("private-provider-body")).not.toContain("private-provider-body");
});
