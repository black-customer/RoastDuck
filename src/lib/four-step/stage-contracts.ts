import type { AiRole } from "@/lib/ai/contracts";
import type {MaterialInput} from './material-types';
import {TrainingError} from './shared';

export const STAGE_CONTRACTS = {
  diagnosis: { prompt:"answer_gap_diagnosis.generator.v2.md", role:"gap_generator" },
  selection: { prompt:"answer_gap_diagnosis.reviewer.v2.md", role:"gap_reviewer" },
  material: { prompt:"four_step_material.generator.v2.md", role:"learning_material_compiler" },
  review: { prompt:"four_step_material.reviewer.v2.md", role:"reviewer" },
} satisfies Record<string,{prompt:string;role:AiRole}>;
export const DIAGNOSIS_REPAIR_PROMPT="answer_gap_diagnosis.repair.v1.md";
export const SPOKEN_STYLE_VERSION='personal-spoken-v2' as const;
export const SELECTION_POLICY_VERSION='evidence-exclusion-v1' as const;
export const SPOKEN_STAGE_CONTRACTS={
  diagnosis:{prompt:'answer_gap_diagnosis.generator.v3.md',role:'gap_generator'},
  selection:{prompt:'answer_gap_diagnosis.reviewer.v3.md',role:'gap_reviewer'},
  material:{prompt:'four_step_material.generator.v3.md',role:'learning_material_compiler'},
  review:{prompt:'four_step_material.reviewer.v3.md',role:'reviewer'},
} satisfies Record<keyof typeof STAGE_CONTRACTS,{prompt:string;role:AiRole}>;
export const RECALL_STAGE_CONTRACTS={
  ...SPOKEN_STAGE_CONTRACTS,
  material:{prompt:'four_step_material.generator.v4.md',role:'learning_material_compiler'},
  review:{prompt:'four_step_material.reviewer.v4.md',role:'reviewer'},
} satisfies Record<keyof typeof STAGE_CONTRACTS,{prompt:string;role:AiRole}>;
export const SPOKEN_DIAGNOSIS_REPAIR_PROMPT='answer_gap_diagnosis.repair.v2.md';
export const EVIDENCED_STAGE_CONTRACTS={...RECALL_STAGE_CONTRACTS,selection:{prompt:'answer_gap_diagnosis.reviewer.v4.md',role:'gap_reviewer'}} satisfies Record<keyof typeof STAGE_CONTRACTS,{prompt:string;role:AiRole}>;
export function materialStageContracts(source:Pick<MaterialInput,'spokenStyleVersion'|'selectionPolicyVersion'>){
  if(source.selectionPolicyVersion){
    if(source.spokenStyleVersion!==SPOKEN_STYLE_VERSION||source.selectionPolicyVersion!==SELECTION_POLICY_VERSION)throw new TrainingError('未知的选材政策版本，原记录保留',422,'material_selection_version');
    return EVIDENCED_STAGE_CONTRACTS;
  }
  if(source.spokenStyleVersion===SPOKEN_STYLE_VERSION)return RECALL_STAGE_CONTRACTS;
  if(source.spokenStyleVersion==='personal-spoken-v1')return SPOKEN_STAGE_CONTRACTS;
  if(source.spokenStyleVersion!==undefined)throw new TrainingError('未知的材料风格版本，保留原记录',422,'material_style_version');
  return STAGE_CONTRACTS;
}
export const diagnosisRepairPrompt=(source:Pick<MaterialInput,'spokenStyleVersion'>)=>source.spokenStyleVersion?SPOKEN_DIAGNOSIS_REPAIR_PROMPT:DIAGNOSIS_REPAIR_PROMPT;
