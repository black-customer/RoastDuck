import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
export const credentialInputSchema=z.object({provider:z.enum(['mimo','deepseek']),key:z.string().regex(/^[A-Za-z0-9._-]{8,512}$/).nullable()}).strict();
type Input=z.infer<typeof credentialInputSchema>;
let tail:Promise<unknown>=Promise.resolve();
/** User-entered values are write-only. No key is read back to the browser or copied to logs/backups. */
export function saveServerCredential(root:string,input:Input){
  const task=tail.then(async()=>{
    const value=credentialInputSchema.parse(input),name=value.provider==='mimo'?'MIMO_API_KEY':'DEEPSEEK_API_KEY';
    const target=path.resolve(root,'.env.local'),privateDir=path.resolve(root,'data/private-settings');
    await fs.mkdir(privateDir,{recursive:true,mode:0o700});
    const text=await fs.readFile(target,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}),newline=text.includes('\r\n')?'\r\n':'\n';
    let found=false;const lines=text.split(/\r?\n/).map(line=>{
      if(!new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line))return line;
      found=true;return `${name}=${value.key??''}`;
    });
    if(!found)lines.push(`${name}=${value.key??''}`);
    const temporary=path.join(privateDir,`credential-${randomUUID()}.env`);
    try{await fs.writeFile(temporary,lines.join(newline),{flag:'wx',mode:0o600});await fs.rename(temporary,target);}finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    return {name,configured:value.key!==null};
  });tail=task.catch(()=>undefined);return task;
}
