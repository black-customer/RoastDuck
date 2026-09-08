// Whitelist learning prompts; no development documents, credentials or private originals enter the APK.
import diagnosis from "../../pipeline/prompts/answer_gap_diagnosis.generator.v2.md?raw";
import selection from "../../pipeline/prompts/answer_gap_diagnosis.reviewer.v2.md?raw";
import material from "../../pipeline/prompts/four_step_material.generator.v2.md?raw";
import review from "../../pipeline/prompts/four_step_material.reviewer.v2.md?raw";
import repair from "../../pipeline/prompts/answer_gap_diagnosis.repair.v1.md?raw";
import dialogue from "../../pipeline/prompts/companion_dialogue.chloe.v2.md?raw";
import memory from "../../pipeline/prompts/companion_memory.extractor.v1.md?raw";
import judge from "../../pipeline/prompts/four_step_retrieval.judge.v1.md?raw";
const prompts:Record<string,string>={
  "answer_gap_diagnosis.generator.v2.md":diagnosis,"answer_gap_diagnosis.reviewer.v2.md":selection,
  "four_step_material.generator.v2.md":material,"four_step_material.reviewer.v2.md":review,
  "answer_gap_diagnosis.repair.v1.md":repair,"companion_dialogue.chloe.v2.md":dialogue,
  "companion_memory.extractor.v1.md":memory,"four_step_retrieval.judge.v1.md":judge,
};
export function loadPrompt(name:string){const text=prompts[name];if(!text)throw new Error("所需学习Prompt未随应用发布");return text;}
