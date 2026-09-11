import {DatabaseSync} from "node:sqlite";
import {SerialDatabase,type SqlCommand,type TransactionDriver} from "@/lib/platform/database";
import snapshot from "@/lib/platform/android/generated/schema.json";
import {V29_DDL} from '../../db/migrations/v29-web-usability';
import {V30_DDL} from '../../db/migrations/v30-web-speech-lock';
import {V31_DDL} from '../../db/migrations/v31-web-material-controls';
import {V32_DDL} from '../../db/migrations/v32-expression-study';
import {V33_DDL} from '../../db/migrations/v33-sentence-study';
import {V34_DDL} from '../../db/migrations/v34-personal-focus';
import {V35_DDL} from '../../db/migrations/v35-guided-reveal';
/** Real SQLite in memory, native schema, no production paths and no libsql worker lifecycle. */
export function portableTestDatabase(){
  const connection=new DatabaseSync(":memory:");
  for(const statement of snapshot.statements)connection.exec(statement);
  // Web-only additive migrations. The frozen Android production snapshot is not regenerated.
  for(const statement of V29_DDL)connection.exec(statement);
  for(const statement of V30_DDL)connection.exec(statement);
  for(const statement of V31_DDL)connection.exec(statement);
  for(const statement of V32_DDL)connection.exec(statement);
  for(const statement of V33_DDL)connection.exec(statement);
  for(const statement of V34_DDL)connection.exec(statement);
  for(const statement of V35_DDL)connection.exec(statement);
  const driver:TransactionDriver={
    async begin(mode){connection.exec("BEGIN");if(mode==="read")connection.exec("PRAGMA query_only=ON");},
    async commit(){connection.exec("PRAGMA query_only=OFF; COMMIT");},
    async rollback(){connection.exec("PRAGMA query_only=OFF; ROLLBACK");},
    async all<T>(command:SqlCommand){return connection.prepare(command.sql).all(...command.args??[]) as T[];},
    async run(command){const result=connection.prepare(command.sql).run(...command.args??[]);return {changes:Number(result.changes)};},
  };
  return {database:new SerialDatabase(driver),connection,close:()=>connection.close()};
}
