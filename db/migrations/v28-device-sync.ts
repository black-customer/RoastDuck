/** Record-level exchange, never database-file replacement. Pairing secrets live outside these tables. */
export const V28_DDL=[
  `CREATE TABLE device_sync_changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT,change_id TEXT NOT NULL UNIQUE,device_id TEXT NOT NULL,entity TEXT NOT NULL,record_key TEXT NOT NULL,parents_json TEXT NOT NULL,payload_json TEXT NOT NULL,changed_at TEXT NOT NULL)`,
  `CREATE TABLE device_sync_heads (entity TEXT NOT NULL,record_key TEXT NOT NULL,heads_json TEXT NOT NULL,projection_hash TEXT NOT NULL,PRIMARY KEY(entity,record_key))`,
  `CREATE TABLE device_sync_conflicts (id TEXT PRIMARY KEY,entity TEXT NOT NULL,record_key TEXT NOT NULL,heads_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'unresolved',reason TEXT NOT NULL,created_at TEXT NOT NULL)`,
  `CREATE TABLE device_sync_receipts (peer_id TEXT PRIMARY KEY,received_sequence INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)`,
  `CREATE TABLE device_sync_owners (entity TEXT NOT NULL,record_key TEXT NOT NULL,owner_device_id TEXT NOT NULL,paused INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(entity,record_key))`,
  `CREATE INDEX device_sync_record ON device_sync_changes(entity,record_key,sequence)`,
  `CREATE TABLE device_sync_chat_branches (conversation_id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,origin_device_id TEXT NOT NULL,fork_sequence INTEGER NOT NULL,fork_message_id TEXT NOT NULL,UNIQUE(parent_id,origin_device_id,fork_message_id))`,
];
