import { expect,it } from "vitest";
import { createClient } from "@libsql/client";
import { prepareTestDatabase } from "../helpers/temp-db";
import {migrationHistory,removePostV25Schema} from '../helpers/legacy-schema';
const temporary=prepareTestDatabase("v25-upgrade");
process.env.ROASTDUCK_DB=temporary.url;process.env.ROASTDUCK_SKIP_DB_BACKUP="1";process.env.AI_PROVIDER="mock";

it("real v24-shaped stored review upgrades to V1, keeps queue/reveal/progress and can finish",async()=>{
  const db=await(await import("@db/client")).getDbReady();
  const {publishLightFixture}=await import("../helpers/light-material");
  const fixture=await publishLightFixture(db,"v25-old-source","brush my teeth","刷牙");
  const {cards}=await(await import("@/lib/light-study/catalogue")).readLightCatalogue({type:"material",id:fixture.materialId});
  const storedCard={...cards[0],progressVersion:1},scope=JSON.stringify({type:"material",id:fixture.materialId});
  const client=createClient({url:temporary.url});
  try{
    await removePostV25Schema(client,temporary.url);
    // Reconstruct v24 physical columns, not a V2 session with only its label changed.
    for(const [table,column] of [["light_study_sessions","experience_version"],["light_study_sessions","round_json"],["light_study_events","phase"]])await client.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    await client.execute("DELETE FROM _schema_migrations WHERE version=25");
    const previousHistory=await migrationHistory(client,24);
    await client.execute({sql:"INSERT INTO light_study_progress(learning_item_id,first_seen_at,last_seen_at,due_at) VALUES (?,?,?,?)",args:[storedCard.itemId,"2026-09-06T00:00:00Z","2026-09-06T00:00:00Z","2026-09-07T00:00:00Z"]});
    const queue=JSON.stringify([storedCard]);
    await client.execute({sql:"INSERT INTO light_study_sessions(id,scope_key,scope_json,mode,queue_json,revealed,version,created_at,updated_at) VALUES (?,?,?,'review',?,1,7,?,?)",args:["old-v24-review",scope,scope,queue,"2026-09-07T00:00:00Z","2026-09-07T00:00:00Z"]});
    await(await import("@db/migrate")).ensureSchema(client,temporary.url);
    expect((await migrationHistory(client)).map(row=>row.version)).toEqual(Array.from({length:34},(_,index)=>index+1));
    expect(await migrationHistory(client,24)).toEqual(previousHistory);
    const row=(await client.execute("SELECT * FROM light_study_sessions WHERE id='old-v24-review'")).rows[0];
    expect(row).toMatchObject({experience_version:"light_study_v1",round_json:null,queue_json:queue,revealed:1,version:7});
    const service=await import("@/lib/light-study/service");
    expect(await service.getLightView("old-v24-review")).toMatchObject({experienceVersion:"light_study_v1",revealed:false,needsUpgrade:true,version:7});
    const completed=await service.applyLightEvent("old-v24-review",{type:"rate",rating:"remembered",version:7,clientEventId:"old-review-finish"},new Date("2026-09-07T08:00:00Z"));
    expect(completed.status).toBe("completed");
    expect((await client.execute("SELECT review_count FROM light_study_progress")).rows[0].review_count).toBe(1);
  }finally{client.close();}
});
