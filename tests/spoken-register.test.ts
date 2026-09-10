import fs from 'node:fs';
import {expect,it} from 'vitest';
import {spokenInstructions,SPOKEN_REGISTER_PROMPT} from '@/lib/ai/spoken-register';
import {materialStageContracts,diagnosisRepairPrompt} from '@/lib/four-step/stage-contracts';
it('new material binds real versioned style prompts; old tasks retain old contracts',async()=>{
  const old={sentenceStudyVersion:'sentence-material-v1' as const,spokenStyleVersion:'personal-spoken-v2' as const,selectionPolicyVersion:'evidence-exclusion-v1' as const};
  const modern={...old,registerProfileVersion:'young-us-v1' as const};
  expect(materialStageContracts(old).material.prompt).toBe('sentence_material.generator.v1.md');
  expect(materialStageContracts(modern).material.prompt).toBe('sentence_material.generator.v2.md');
  for(const name of [...Object.values(materialStageContracts(modern)).map(s=>s.prompt),diagnosisRepairPrompt(modern),SPOKEN_REGISTER_PROMPT,'sentence_coaching.chloe.v2.md'])expect(fs.existsSync('pipeline/prompts/'+name)).toBe(true);
  const load=(name:string)=>fs.readFileSync('pipeline/prompts/'+name,'utf8');
  expect(await spokenInstructions(load,'sentence_material.generator.v2.md','young-us-v1')).toContain('不算用户犯错');
  expect(await spokenInstructions(load,'sentence_material.generator.v1.md')).not.toContain('当代年轻美式口语配置');
});
