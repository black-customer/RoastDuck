import type {SqlReader} from '@/lib/platform/database';
import {query as sql} from '@/lib/platform/sql';
import {canonical,type SyncEntity} from './contracts';
import {TrainingError} from '@/lib/four-step/shared';
/** Must run inside the same transaction as the business write. */
export async function assertLocalOwnership(tx:SqlReader,entity:SyncEntity,id:string){
  const [owner]=await tx.all<{owner_device_id:string;local_id:string|null}>(sql`SELECT o.owner_device_id,(SELECT device_id FROM app_device WHERE singleton=1) local_id FROM device_sync_owners o WHERE o.entity=${entity} AND o.record_key=${canonical([id])}`);
  if(owner&&owner.owner_device_id!==owner.local_id)throw new TrainingError('任务属于另一台设备，请先暂停并同步，再显式接续',409,'remote_owned');
}
export function localOwnerFilter(entity:SyncEntity,qualifiedId:string){
  if(!/^[a-z_]+\.id$/.test(qualifiedId))throw new Error('Invalid internal owner column');
  return sql`NOT EXISTS(SELECT 1 FROM device_sync_owners own WHERE own.entity=${entity} AND own.record_key=json_array(${{sql:qualifiedId}}) AND own.owner_device_id!=COALESCE((SELECT device_id FROM app_device WHERE singleton=1),''))`;
}
