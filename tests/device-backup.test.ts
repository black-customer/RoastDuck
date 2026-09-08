import {afterEach,expect,it} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {createDeviceSync} from '@/lib/device-sync/service';
import {encryptBackup,decryptBackup,createEncryptedBackup,restoreEncryptedBackup} from '@/lib/device-sync/backup';
const fixtures:Array<ReturnType<typeof portableTestDatabase>>=[];
afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
const password='synthetic-backup-password';
function setup(id:string){const f=portableTestDatabase();fixtures.push(f);return {...f,sync:createDeviceSync(f.database,{device_id:id,dataset_id:'dataset'},{now:()=>new Date('2026-09-08T00:00:00Z')})};}
it('authenticated encrypted backup is not readable as plaintext; wrong passwords and tampering fail',async()=>{
  const input=new TextEncoder().encode('仅合成测试内容。My original answer is private.'),encrypted=await encryptBackup(input,password);
  expect(new TextDecoder().decode(encrypted)).not.toContain('original answer');
  expect(await decryptBackup(encrypted,password)).toEqual(input);
  await expect(decryptBackup(encrypted,'incorrect-password')).rejects.toThrow('密码不正确');
  encrypted[encrypted.length-3]^=1;await expect(decryptBackup(encrypted,password)).rejects.toThrow('损坏');
});
it('restoration merges stable records idempotently and never exports the native Key store',async()=>{
  const a=setup('old'),b=setup('new');a.connection.exec("INSERT INTO question_favorites(question_id) VALUES('first')");
  const encrypted=await createEncryptedBackup(a.sync,password),plain=new TextDecoder().decode(await decryptBackup(encrypted,password));
  expect(plain).not.toContain('runtime_requests');expect(plain).not.toContain('pairing');
  const result=await restoreEncryptedBackup(b.sync,encrypted,password);expect(result.restored).toBe(1);
  expect((await restoreEncryptedBackup(b.sync,encrypted,password)).restored).toBe(0);
  expect(b.connection.prepare('SELECT * FROM question_favorites').all()).toHaveLength(1);
});
it('failed decryption never mutates the existing database',async()=>{
  const a=setup('old'),b=setup('new');b.connection.exec("INSERT INTO question_favorites(question_id) VALUES('keep')");
  const encrypted=await createEncryptedBackup(a.sync,password);
  await expect(restoreEncryptedBackup(b.sync,encrypted,'wrong-password')).rejects.toThrow();
  expect(b.connection.prepare('SELECT question_id FROM question_favorites').all()).toEqual([{question_id:'keep'}]);
  expect(b.connection.prepare('SELECT * FROM device_sync_changes').all()).toEqual([]);
});
