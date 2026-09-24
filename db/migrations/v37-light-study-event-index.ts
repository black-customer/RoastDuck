/** 首页"未完成"探针按 learning_item_id 关联事件表；无索引时每次加载全表扫描。只增索引，不改数据。 */
export const V37_DDL = [
  `CREATE INDEX light_study_event_item ON light_study_events(learning_item_id)`,
  `CREATE INDEX light_study_event_created ON light_study_events(created_at)`,
];
