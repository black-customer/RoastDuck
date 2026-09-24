import {afterEach,expect,it} from 'vitest';
import {portableTestDatabase} from './helpers/portable-db';
import {exportWebBackup,restoreWebBackup,WEB_BACKUP_TABLES} from '@/lib/backup/web-business';
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
it('v2 学习进度、Gap 台账与题目练习状态随 Web 备份往返，不再缺表',async()=>{
  const a=setup(),b=setup();
  a.connection.exec(`
    INSERT INTO chunks(id,book_id,canonical_chunk,display_chunk,unit_type,quality_status) VALUES('chunk_bk','book_public','make progress','make progress','lexical_chunk','approved');
    INSERT INTO learning_progress(chunk_id,fsrs_json) VALUES('chunk_bk','{"state":2,"due":"2026-09-01T00:00:00.000Z"}');
    INSERT INTO learning_round_settlements(session_id,chunk_id,completed_at) VALUES('session_bk','chunk_bk','2026-09-01T00:00:00.000Z');
    INSERT INTO answer_gaps(id,answer_id,answer_version_id,gap_type,evidence_text,recommended_expression,explanation_zh,confidence,reviewer_decision,reviewer_reason,reviewer_run_id,learning_fit) VALUES('gap_bk','answer_bk','version_bk','lexical_gap','I achieve progress.','make steady progress','表达说明',0.9,'approved','明确','run_bk',1);
    INSERT INTO question_attempts(id,question_id,status) VALUES('attempt_bk','q_attempts','completed');
    INSERT INTO question_mastery(question_id,mastered) VALUES('q_attempts',1);
  `);
  const bytes=await exportWebBackup(a.database,'long-test-password');
  expect(await restoreWebBackup(b.database,bytes,'long-test-password',true)).toMatchObject({added:6,applied:true});
  expect(b.connection.prepare('SELECT chunk_id FROM learning_progress').get()).toEqual({chunk_id:'chunk_bk'});
  expect(b.connection.prepare('SELECT id FROM answer_gaps').get()).toEqual({id:'gap_bk'});
  expect(b.connection.prepare('SELECT mastered FROM question_mastery').get()).toEqual({mastered:1});
  expect(WEB_BACKUP_TABLES).toContain('review_log');expect(WEB_BACKUP_TABLES).toContain('learning_sessions');
  expect(WEB_BACKUP_TABLES).toContain('personal_gap_evidence');expect(WEB_BACKUP_TABLES).toContain('speaking_sessions');
});
