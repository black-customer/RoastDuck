import { describe, expect, it } from "vitest";
import { runSelectionGolden, selectionFixture } from "../pipeline/golden/material-selection-v2";
import { compileEvidence } from "@/lib/four-step/selection-contracts";
import { speakingAttemptAnalysisSchema } from "@/lib/speaking-practice/schemas";
import { validateMaterial } from "@/lib/four-step/materials";
describe("双输入证据选材",()=>{
  for(const result of runSelectionGolden()) it(result.id,()=>expect(result.ok,result.error).toBe(true));
  it("生成器不能另写第三列中文配合自己的改写",()=>{
    const {source,evidence}=selectionFixture();
    const compiled=speakingAttemptAnalysisSchema.parse(compileEvidence(source,evidence));
    compiled.learningMaterials[0].yourChineseSentence="我准备搬到纽约。";
    expect(()=>validateMaterial(compiled,{...source,sourceType:"free_talk",sourceId:"synthetic",question:null,mode:"relaxed"})).toThrow("四列材料与审核证据不一致");
  });
});
