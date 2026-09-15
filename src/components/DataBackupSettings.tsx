'use client';
import {useRef, useState} from 'react';
import styles from './DataBackupSettings.module.css';

const CHUNK_BYTES = 4 * 1024 * 1024;
type Preview = {added: number; conflicts: number; files: number; format: number; deletionMarkers?: number; settingsToRestore?: number; missingAudio: Array<{id: string}>};
type Restored = Preview & {restoredFiles?: number; restoredSettings?: number; skippedDeleted?: number; purgePending?: number; beforeRestoreMissingAudio?: number};
type Exported = {url: string; files: number; missingAudio: Array<{id: string}>};
async function post<T>(input: unknown): Promise<T> {
  const response = await fetch('/api/data-backup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '备份操作未完成，请重试。');
  return body;
}
export function DataBackupSettings() {
  const [password, setPassword] = useState(''), [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [preview, setPreview] = useState<Preview | null>(null);
  const [download, setDownload] = useState<string | null>(null), [uploadProgress, setUploadProgress] = useState<number | null>(null);
  // A retry is tied to the same selected File object. Selecting a new file always
  // creates a new upload, even when its name/size/mtime happens to match.
  const upload = useRef<{file: File; id: string} | null>(null);
  async function uploadFile(selected: File) {
    if (!selected.size) throw new Error('备份文件为空，请重新选择。');
    if (selected.size > 32 * 1024 * 1024 * 1024) throw new Error('本版支持不超过 32 GiB 的备份文件。');
    if (upload.current?.file !== selected) upload.current = {file: selected, id: crypto.randomUUID()};
    const id = upload.current.id;
    const saved = await post<{offset: number}>({action: 'begin_import', clientId: id, bytes: selected.size});
    let offset = saved.offset;
    setMessage('正在上传备份到本机…'); setUploadProgress(Math.floor(offset / selected.size * 100));
    while (offset < selected.size) {
      const response = await fetch(`/api/data-backup/uploads/${id}?offset=${offset}`, {
        method: 'PUT', headers: {'Content-Type': 'application/octet-stream', 'X-Roastduck-Backup': '1'},
        body: selected.slice(offset, Math.min(selected.size, offset + CHUNK_BYTES)),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '上传中断，再次检查会从已保存的位置继续。');
      if (!Number.isSafeInteger(body.nextOffset) || body.nextOffset <= offset || body.nextOffset > selected.size) throw new Error('上传位置尚未确认，请再次检查备份。');
      offset = body.nextOffset; setUploadProgress(Math.floor(offset / selected.size * 100));
    }
    setUploadProgress(null); return id;
  }
  async function act(action: 'export' | 'preview' | 'restore') {
    if (busy) return;
    setBusy(true); setMessage(''); setUploadProgress(null);
    try {
      if (action === 'export') {
        setDownload(null); setMessage('正在加密业务资料和原声音频…');
        const result = await post<Exported>({action: 'export_v2', password});
        setDownload(result.url);
        const link = document.createElement('a'); link.href = result.url; link.download = ''; link.click();
        setMessage(`已生成加密备份，包含 ${result.files} 份原声。请检查浏览器下载是否完成。${result.missingAudio.length ? `有 ${result.missingAudio.length} 份原声在本机已缺失，备份保留了缺失记录。` : ''}`);
      } else {
        if (!file) throw new Error('请选择备份文件。');
        const uploadId = await uploadFile(file);
        setMessage(action === 'preview' ? '正在验证密码、完整备份和原声文件…' : '正在保留当前备份并补回资料…');
        if (action === 'preview') {
          const result = await post<Preview>({action: 'preview_import', password, uploadId});
          setPreview(result); setMessage('备份检查完成，现有资料尚未改变。');
        } else {
          const result = await post<Restored>({action: 'restore_import', password, uploadId});
          setPreview(null);
          setMessage(`已补回 ${result.added} 条记录、${result.restoredFiles ?? 0} 份原声；保留 ${result.conflicts} 条本机版本差异及删除标记。${result.restoredSettings ? '已补回此前尚未设置的学习与老师声音偏好。' : ''}${result.missingAudio.length ? `仍有 ${result.missingAudio.length} 份原声缺失或存在文件冲突，可在回答历史查看。` : ''}${result.purgePending ? `${result.purgePending} 份已永久删除的原声仍待清理本机文件。` : ''}${result.beforeRestoreMissingAudio ? `恢复前备份中有 ${result.beforeRestoreMissingAudio} 份原声已缺失。` : ''}`);
        }
      }
    } catch (reason) {setMessage(reason instanceof Error ? reason.message : '备份未完成，请重试。');}
    finally {setBusy(false); setUploadProgress(null);}
  }
  return <section className="settings-section">
    <h2>本机数据备份</h2>
    <p>保存原回答、材料、备注、进度和原声音频。备份含私人内容，请妥善保管；密码无法找回。</p>
    <label className="settings-field">备份密码（至少 10 位）<input type="password" autoComplete="new-password" value={password} disabled={busy} maxLength={1024} onChange={event => {setPassword(event.target.value); setPreview(null);}}/></label>
    <button className="secondary-button" disabled={busy || password.length < 10} onClick={() => void act('export')}>下载加密备份（含原声）</button>
    {download && <a className={styles.download} href={download} download>下载未开始？再次下载这份备份</a>}
    <p className={styles.hint}>不包含 API Key 或示范音频缓存。永久删除无法撤回，也无法擦除你以前导出的备份。</p>
    <div className={styles.restore}>
      <label className="settings-field">恢复已有备份<input type="file" accept=".rdbackup" disabled={busy} onChange={event => {setFile(event.target.files?.[0] ?? null); upload.current = null; setPreview(null); setMessage('');}}/></label>
      <button className="secondary-button" disabled={busy || !file || password.length < 10} onClick={() => void act('preview')}>检查备份，不改数据</button>
      {preview && <div className={styles.preview}>
        <p>可补回 {preview.added} 条记录；包内有 {preview.files} 份原声。{preview.conflicts} 条本机版本差异将保留，移除和永久删除标记优先。</p>
        {preview.format === 1 && <p>这是旧版备份，其中不含原声音频。</p>}
        {!!preview.settingsToRestore && <p>本机尚未设置声音偏好，可以一并补回备份中的学习与老师声线。</p>}
        {preview.missingAudio.length > 0 && <p>包内有 {preview.missingAudio.length} 份原声已缺失，恢复后仍会标记缺失。</p>}
        <p className={styles.hint}>确认后先保存一份当前加密备份，再补回缺失资料。</p>
        <button className="primary-button" disabled={busy} onClick={() => void act('restore')}>确认补回资料和原声</button>
      </div>}
    </div>
    {uploadProgress !== null && <progress className={styles.progress} max={100} value={uploadProgress} aria-label={`备份上传 ${uploadProgress}%`}/>}
    {message && <p className={styles.status} role="status">{message}</p>}
  </section>;
}
