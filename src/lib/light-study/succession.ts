import type {SqlReader,SqlWriter} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {hash} from '@/lib/four-step/shared';
import {createLightCatalogue} from './core-catalogue';
import {createLightRound} from './round';
import type {LightCard,LightMode} from './contracts';
export interface LegacySession {id:string;scope_key:string;scope_json:string;mode:LightMode;status:string;version:number;cursor:number;queue_json:string}
export interface Succession {legacy_session_id:string;current_session_id:string|null;cutover_version:number;remaining_json:string}
export async function findSuccession(db:SqlReader,id:string){return (await db.all<Succession>(sql`SELECT * FROM light_study_successions WHERE legacy_session_id=${id}`))[0]??null;}
export const notSuperseded=sql`NOT EXISTS(SELECT 1 FROM light_study_successions s WHERE s.legacy_session_id=light_study_sessions.id)`;

/** Called only in a POST transaction after any submitted old event has been reconciled. */
export async function continueLegacy(db:SqlWriter,legacy:LegacySession,now:Date,allowMock=false):Promise<string>{
  let link=await findSuccession(db,legacy.id);
  if(link?.current_session_id){const [current]=await db.all<{id:string;status:string}>(sql`SELECT id,status FROM light_study_sessions WHERE id=${link.current_session_id}`);if(current&&current.status!=='completed')return current.id;}
  if(!link){
    const remaining=(JSON.parse(legacy.queue_json) as LightCard[]).slice(legacy.cursor);
    await db.run(sql`INSERT INTO light_study_successions(legacy_session_id,cutover_version,remaining_json,created_at,updated_at) VALUES(${legacy.id},${legacy.version},${JSON.stringify(remaining)},${now.toISOString()},${now.toISOString()})`);
    await db.run(sql`UPDATE light_study_sessions SET status='paused' WHERE id=${legacy.id}`);
    link=(await findSuccession(db,legacy.id))!;
  }
  const pending=JSON.parse(link.remaining_json) as LightCard[],valid:LightCard[]=[],seen=new Set<string>();
  for(const card of pending){
    if(seen.has(card.itemId))continue;seen.add(card.itemId);
    const [progress]=await db.all<{version:number;due_at:string}>(sql`SELECT version,due_at FROM light_study_progress WHERE learning_item_id=${card.itemId}`);
    if(legacy.mode==='learn'&&progress||legacy.mode==='review'&&(!progress||progress.due_at>now.toISOString()))continue;
    const refreshed={...card,progressVersion:progress?.version??0};
    if(await createLightCatalogue(db,allowMock).snapshotAvailability(refreshed))continue;
    valid.push(refreshed);
  }
  const cards=valid.slice(0,5),remaining=valid.slice(5);
  if(!cards.length){await db.run(sql`UPDATE light_study_successions SET remaining_json='[]',updated_at=${now.toISOString()} WHERE legacy_session_id=${legacy.id}`);return link.current_session_id??legacy.id;}
  const [{batch}]=await db.all<{batch:number}>(sql`SELECT COALESCE(MAX(batch_no),0)+1 batch FROM light_study_succession_batches WHERE legacy_session_id=${legacy.id}`);
  const id=`light_successor_${hash(legacy.id,String(batch)).slice(0,24)}`;
  await db.run(sql`INSERT INTO light_study_sessions(id,scope_key,scope_json,mode,queue_json,experience_version,round_json,created_at,updated_at) VALUES(${id},${legacy.scope_key},${legacy.scope_json},${legacy.mode},${JSON.stringify(cards)},'light_study_v2',${JSON.stringify(createLightRound(cards.length))},${now.toISOString()},${now.toISOString()})`);
  await db.run(sql`INSERT INTO light_study_succession_batches(legacy_session_id,batch_no,session_id,created_at) VALUES(${legacy.id},${batch},${id},${now.toISOString()})`);
  await db.run(sql`UPDATE light_study_successions SET current_session_id=${id},remaining_json=${JSON.stringify(remaining)},updated_at=${now.toISOString()} WHERE legacy_session_id=${legacy.id}`);
  return id;
}
