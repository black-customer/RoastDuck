"use client";

import { useState, type FormEvent } from "react";
import type { UserSettings } from "@/lib/settings";

export function SettingsForm({ initialSettings }: { initialSettings: UserSettings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setMessage("");
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({autoPlay:settings.autoPlay,autoCollectDifficulties:settings.autoCollectDifficulties}),
      });
      const body = (await response.json()) as { settings?: UserSettings; error?: string };
      if (!response.ok || !body.settings) throw new Error(body.error || "设置没有保存成功");
      setSettings(body.settings);
      setMessage("设置已保存，下一步学习会立即使用。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设置没有保存成功，请检查连接后重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={save}>
      <section className="settings-section" aria-labelledby="collection-title">
        <div className="settings-section-copy">
          <h2 id="collection-title">查询与记录</h2>
          <p>保持探索自由，不让一次试点变成永久难点。</p>
        </div>
        <label className="settings-switch-row">
          <span>
            <strong>查询时自动收藏</strong>
            <small>默认关闭。开启后仅将查词保存为个人收藏，不代表 AI 确认的表达缺口。</small>
          </span>
          <input
            type="checkbox"
            checked={settings.autoCollectDifficulties}
            onChange={(event) => update("autoCollectDifficulties", event.target.checked)}
          />
          <span className="settings-switch" aria-hidden="true" />
        </label>
      </section>

      <section className="settings-section" aria-labelledby="audio-title">
        <div className="settings-section-copy">
          <h2 id="audio-title">声音</h2>
          <p>轻松学揭晓后尝试播放。声音未就绪不会挡住下一步。</p>
        </div>
        <label className="settings-switch-row">
          <span>
            <strong>揭晓后自动播放</strong>
            <small>揭晓前不播放答案。你也可以随时手动试听。</small>
          </span>
          <input
            type="checkbox"
            checked={settings.autoPlay}
            onChange={(event) => update("autoPlay", event.target.checked)}
          />
          <span className="settings-switch" aria-hidden="true" />
        </label>
      </section>

      {error ? <p className="settings-message is-error" role="alert">{error}</p> : null}
      {message ? <p className="settings-message" role="status">{message}</p> : null}
      <button type="submit" className="primary-button settings-save" disabled={saving}>
        {saving ? "正在保存…" : "保存设置"}
      </button>
    </form>
  );
}
