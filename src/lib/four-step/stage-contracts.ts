import type { AiRole } from "@/lib/ai/contracts";
import type {MaterialInput} from './material-types';
import {TrainingError} from './shared';
import {SPOKEN_REGISTER_VERSION} from '@/lib/ai/spoken-register';

export const STAGE_CONTRACTS = {
  diagnosis: { prompt:"answer_gap_diagnosis.generator.v2.md", role:"gap_generator" },
  selection: { prompt:"answer_gap_diagnosis.reviewer.v2.md", role:"gap_reviewer" },
  material: { prompt:"four_step_material.generator.v2.md", role:"learning_material_compiler" },
  review: { prompt:"four_step_material.reviewer.v2.md", role:"reviewer" },
} satisfies Record<string,{prompt:string;role:AiRole}>;
export const DIAGNOSIS_REPAIR_PROMPT="answer_gap_diagnosis.repair.v1.md";
export const SPOKEN_STYLE_VERSION='personal-spoken-v2' as const;
export const SELECTION_POLICY_VERSION='evidence-exclusion-v1' as const;
export const SENTENCE_STUDY_VERSION='sentence-material-v1' as const;
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
export const SENTENCE_STAGE_CONTRACTS={...EVIDENCED_STAGE_CONTRACTS,diagnosis:{prompt:'sentence_intention.generator.v1.md',role:'gap_generator'},material:{prompt:'sentence_material.generator.v1.md',role:'learning_material_compiler'},review:{prompt:'sentence_material.reviewer.v1.md',role:'reviewer'}} satisfies Record<keyof typeof STAGE_CONTRACTS,{prompt:string;role:AiRole}>;
export const YOUNG_US_STAGE_CONTRACTS={...SENTENCE_STAGE_CONTRACTS,diagnosis:{prompt:'sentence_intention.generator.v2.md',role:'gap_generator'},selection:{prompt:'answer_gap_diagnosis.reviewer.v5.md',role:'gap_reviewer'},material:{prompt:'sentence_material.generator.v2.md',role:'learning_material_compiler'},review:{prompt:'sentence_material.reviewer.v2.md',role:'reviewer'}} satisfies typeof SENTENCE_STAGE_CONTRACTS;
export function materialStageContracts(source:Pick<MaterialInput,'spokenStyleVersion'|'selectionPolicyVersion'|'sentenceStudyVersion'|'registerProfileVersion'>){
  if(source.registerProfileVersion&&source.registerProfileVersion!==SPOKEN_REGISTER_VERSION)throw new TrainingError('材料表达风格版本不兼容',422,'material_register_version');
  if(source.sentenceStudyVersion){if(source.sentenceStudyVersion!==SENTENCE_STUDY_VERSION||source.spokenStyleVersion!==SPOKEN_STYLE_VERSION||source.selectionPolicyVersion!==SELECTION_POLICY_VERSION)throw new TrainingError('句子材料版本不兼容',422,'sentence_material_version');return source.registerProfileVersion?YOUNG_US_STAGE_CONTRACTS:SENTENCE_STAGE_CONTRACTS;}
  if(source.selectionPolicyVersion){
    if(source.spokenStyleVersion!==SPOKEN_STYLE_VERSION||source.selectionPolicyVersion!==SELECTION_POLICY_VERSION)throw new TrainingError('未知的选材政策版本，原记录保留',422,'material_selection_version');
    return EVIDENCED_STAGE_CONTRACTS;
  }
  if(source.spokenStyleVersion===SPOKEN_STYLE_VERSION)return RECALL_STAGE_CONTRACTS;
  if(source.spokenStyleVersion==='personal-spoken-v1')return SPOKEN_STAGE_CONTRACTS;
  if(source.spokenStyleVersion!==undefined)throw new TrainingError('未知的材料风格版本，保留原记录',422,'material_style_version');
  return STAGE_CONTRACTS;
}
export const diagnosisRepairPrompt=(source:Pick<MaterialInput,'spokenStyleVersion'|'registerProfileVersion'>)=>source.registerProfileVersion?'sentence_intention.repair.v1.md':source.spokenStyleVersion?SPOKEN_DIAGNOSIS_REPAIR_PROMPT:DIAGNOSIS_REPAIR_PROMPT;
