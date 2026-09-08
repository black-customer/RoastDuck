export const V31_DDL=[
  `CREATE TABLE expression_preferences (learning_item_id TEXT PRIMARY KEY,hidden INTEGER NOT NULL DEFAULT 0,favorite INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)`,
  `CREATE TABLE material_feedback (id TEXT PRIMARY KEY,material_id TEXT NOT NULL,material_hash TEXT NOT NULL,learning_item_id TEXT NOT NULL,row_index INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL)`,
];
