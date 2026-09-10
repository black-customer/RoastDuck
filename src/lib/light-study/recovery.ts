import {LightStudyError,type LightView} from './contracts';
import type {LightStudyClient} from './client';
import {clearPending,listPending,type PendingOperation} from './pending';

export class PendingSaveError extends Error {
  constructor(public operation:PendingOperation,public cause:unknown){
    super(cause instanceof Error?cause.message:'记录暂未确认，请重试保存');
    this.name='PendingSaveError';
  }
}

/** Replay each recorded payload once, oldest first. Never manufacture a replacement rating. */
export async function reconcileLightPending(
  session:LightView,client:Pick<LightStudyClient,'get'|'event'>,
  storage?:Parameters<typeof listPending>[1],
):Promise<LightView>{
  const ids=[...new Set([session.legacySessionId,session.id].filter((id):id is string=>Boolean(id)))];
  let current=session;
  for(const id of ids){
    const operations=listPending(id,storage);
    for(const op of operations){
      try{
        try{current=await client.event(op.id,op.event);}
        catch(error){
          if(!(error instanceof LightStudyError)||error.code!=='version_conflict')throw error;
          current={...await client.get(op.id),notice:'位置已更新，已恢复最新记录；没有将旧自评应用到其他表达。'};
        }
        clearPending(op,storage);
      }catch(error){throw new PendingSaveError(op,error);}
    }
  }
  return current;
}
