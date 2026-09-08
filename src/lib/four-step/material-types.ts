export interface MaterialInput {
  sourceType: "ielts_practice" | "free_talk"; sourceId: string;
  question: { id: string; textEn: string; textZh: string; part: number } | null;
  mode: string; actualAnswer: string; intendedMeaningZh: string;
  /** Bound to this material snapshot; old snapshots keep their original generation contract. */
  spokenStyleVersion?: 'personal-spoken-v1';
  inputFormat?: 'mixed-v1';
  rawInput?: string;
  sourceMessages?: Array<{ id: string; role: string; text: string }>;
}
export interface MaterialRow {
  contract_version: string;
  id: string; source_type: string; source_id: string; question_id: string | null;
  input_json: string; input_hash: string; analysis_json: string; status: string;
  generator_run_id: string | null; reviewer_run_id: string | null; review_json: string;
  job_id: string | null; lease_until: string | null; lease_token: string | null;
  created_at: string; updated_at: string; error_code: string | null;
}
