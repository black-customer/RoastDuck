import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {saveServerCredential,credentialInputSchema} from '@/lib/settings-credentials';
it('writes only the selected credential, preserves other settings, and never returns key values',async()=>{
  const root=await fs.mkdtemp(path.resolve('test-results/credentials-'));
  await fs.writeFile(path.join(root,'.env.local'),'# Synthetic settings\nAI_PROVIDER=mock\nDEEPSEEK_API_KEY=synthetic-existing\n');
  const result=await saveServerCredential(root,{provider:'mimo',key:'synthetic-new-key'});expect(result).toEqual({name:'MIMO_API_KEY',configured:true});
  const contents=await fs.readFile(path.join(root,'.env.local'),'utf8');expect(contents).toContain('DEEPSEEK_API_KEY=synthetic-existing');expect(contents).toContain('MIMO_API_KEY=synthetic-new-key');
  expect(await fs.readdir(path.join(root,'data/private-settings'))).toEqual([]);
  await saveServerCredential(root,{provider:'mimo',key:null});expect(await fs.readFile(path.join(root,'.env.local'),'utf8')).not.toContain('synthetic-new-key');
});
it('rejects env injection and unsupported providers',()=>{
  expect(credentialInputSchema.safeParse({provider:'mimo',key:'key\nAI_PROVIDER=unsafe'}).success).toBe(false);
  expect(credentialInputSchema.safeParse({provider:'other',key:'synthetic-key'}).success).toBe(false);
});
