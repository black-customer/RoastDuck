import {afterEach,expect,it} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {exportWebBackup,restoreWebBackup} from '@/lib/backup/web-business';
const fixtures:Array<ReturnType<typeof portableTestDatabase>>=[];afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function setup(){const f=portableTestDatabase();fixtures.push(f);f.connection.exec("INSERT INTO _schema_migrations(version,name,checksum) VALUES(31,'isolated-fixture','fixture')");return f;}
it('encrypted Web backup restores missing business records without starting sync or overwriting changed data',async()=>{
  const a=setup(),b=setup();a.connection.exec("INSERT INTO questions(id,book_id,part,text,text_zh,norm_text) VALUES('q','removed',1,'Do you like music?','你喜欢音乐吗？','q')");
  const bytes=await exportWebBackup(a.database,'long-test-password');expect(Buffer.from(bytes).toString()).not.toContain('Do you like music?');
  expect(await restoreWebBackup(b.database,bytes,'long-test-password')).toMatchObject({added:1,applied:false});expect(b.connection.prepare('SELECT * FROM questions').all()).toHaveLength(0);
  expect(await restoreWebBackup(b.database,bytes,'long-test-password',true)).toMatchObject({added:1,applied:true});
  b.connection.exec("UPDATE questions SET text_zh='保留新版本' WHERE id='q'");
  expect(await restoreWebBackup(b.database,bytes,'long-test-password',true)).toMatchObject({added:0,conflicts:1});expect(b.connection.prepare('SELECT text_zh FROM questions').get()).toEqual({text_zh:'保留新版本'});
  expect(b.connection.prepare('SELECT * FROM app_device').all()).toHaveLength(0);expect(b.connection.prepare('SELECT * FROM ai_runs').all()).toHaveLength(0);
  await expect(restoreWebBackup(b.database,bytes,'incorrect-password',true)).rejects.toThrow(/密码/);
});
