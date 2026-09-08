/** Alias is deliberately fixed to pm so desktop and portable SQL use the same version rule. */
export const currentReadyMaterialPredicate=`NOT EXISTS (
  SELECT 1 FROM practice_materials newer
  WHERE newer.source_type=pm.source_type AND newer.source_id=pm.source_id
    AND newer.contract_version='evidence_v2' AND newer.status='ready'
    AND (julianday(newer.created_at)>julianday(pm.created_at)
      OR julianday(newer.created_at)=julianday(pm.created_at) AND newer.id>pm.id)
)`;
