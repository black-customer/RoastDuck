import {NextResponse} from 'next/server';
import {getSpeechHealth} from '@/lib/speech/config';
import {nodeDatabase} from '@/lib/platform/node/database';
import {query as sql} from '@/lib/platform/sql';
export const dynamic='force-dynamic';
/** Configuration/previous result only. No synthesis, balance lookup or secret value is returned. */
export async function GET(){
  const health=getSpeechHealth();
  const last=await nodeDatabase.read(async tx=>{
    const [row]=await tx.all<{status:string;error_code:string|null;updated_at:string}>(sql`SELECT status,error_code,updated_at FROM speech_requests ORDER BY updated_at DESC,id DESC LIMIT 1`);return row??null;
  });
  return NextResponse.json({...health,lastResult:last},{headers:{'Cache-Control':'no-store'}});
}
