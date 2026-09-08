import {NextResponse} from 'next/server';
import {z} from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {nodeDatabase} from '@/lib/platform/node/database';
import {exportWebBackup,restoreWebBackup} from '@/lib/backup/web-business';
import {localJson} from '@/lib/http/local-write';
import {webError} from '@/lib/http/web-error';
const schema=z.object({action:z.enum(['export','preview','restore']),password:z.string().min(10).max(1024),archive:z.string().max(90_000_000).optional()}).strict();
export async function POST(request:Request){try{
  const input=schema.parse(await localJson(request,91_000_000));
  if(input.action==='export'){const bytes=await exportWebBackup(nodeDatabase,input.password);return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="roastduck-business.rdbackup"','Cache-Control':'no-store'}});}
  if(!input.archive)throw new Error('请选择备份文件');const bytes=Buffer.from(input.archive,'base64');
  // Validate/decrypt the complete archive before preserving a pre-restore backup or mutating rows.
  const preview=await restoreWebBackup(nodeDatabase,bytes,input.password);
  if(input.action==='preview')return NextResponse.json(preview);
  const root=path.resolve(process.env.ROASTDUCK_E2E==='1'||process.env.VITEST?'test-results/backup-restore':'data/backups');await fs.mkdir(root,{recursive:true});
  const prior=await exportWebBackup(nodeDatabase,input.password);await fs.writeFile(path.join(root,`before-restore-${randomUUID()}.rdbackup`),prior,{flag:'wx',mode:0o600});
  return NextResponse.json(await restoreWebBackup(nodeDatabase,bytes,input.password,true));
}catch(error){return webError(error);}}
