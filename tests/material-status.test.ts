import {expect,it} from "vitest";
import {materialFailureMessage,materialDiagnostic} from "@/lib/four-step/material-status";
import {REQUEST_FORMAT_VERSION} from '@/lib/ai/errors';
it("格式、引用、超时分开解释，不把错误源内容直接下发",()=>{
  expect(materialFailureMessage("material_ai_timeout")).toContain("超时");
  expect(materialFailureMessage("material_ai_invalid_output")).toContain("格式");
  expect(materialFailureMessage("material_source_quote")).toContain("引用");
  expect(materialFailureMessage("private-provider-body")).not.toContain("private-provider-body");
});
it('a deployment can unlock an old parameter failure, but the same broken request cannot loop',()=>{
  expect(materialDiagnostic('material_ai_invalid_request').canRetry).toBe(true);
  expect(materialDiagnostic('material_ai_invalid_request','gap_generator',JSON.stringify({requestFormatVersion:REQUEST_FORMAT_VERSION})).canRetry).toBe(false);
  expect(materialDiagnostic('result_unknown').requiresConfirmation).toBe(true);
  expect(materialDiagnostic('material_ai_timeout').requiresConfirmation).toBe(true);
});
