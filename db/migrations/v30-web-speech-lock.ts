/** Global synthesis lease across Web processes sharing a local database. */
export const V30_DDL=[
  `CREATE TABLE speech_lane (singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,expires_at TEXT NOT NULL)`,
];
