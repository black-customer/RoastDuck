import { spawnSync } from "node:child_process";
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from "vitest";
import { getTTS, resolveVoicePreset } from "@/lib/tts";
afterEach(() => { getTTS().stop(); vi.unstubAllGlobals(); });
it("来源口音不会被默认声线覆盖，明确选择声线仍保留", () => {
  expect(resolveVoicePreset("us-female", { lang: "en-GB" }).accent).toBe("en-GB");
  expect(resolveVoicePreset("uk-male").id).toBe("uk-male");
  expect(resolveVoicePreset("us-female", { voiceId: "uk-male", lang: "en-US" }).id).toBe("uk-male");
  expect(resolveVoicePreset("us-female").mimoVoice).toBe("Chloe");
});
it("Android 本地界面缺失立即停止，不打包远程壳或假加载页", () => {
  fs.mkdirSync('test-results',{recursive:true});const cwd=fs.mkdtempSync(path.resolve('test-results/android-missing-ui-'));
  const result = spawnSync(process.execPath, [path.resolve("scripts/build-android.mjs")], { cwd,encoding: "utf8", env: { ...process.env, CAPACITOR_SERVER_URL: "" } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("本地安卓界面尚未构建");
  expect(result.stdout).not.toContain("[1/2]");
});

it("浏览器降级停止后丢弃迟到事件，不结束下一段播放", async () => {
  const utterances: Array<{ onend?: () => void; onerror?: (error: { error: string }) => void }> = [];
  vi.stubGlobal("window", { speechSynthesis: { cancel: () => undefined, getVoices: () => [], speak: (u: typeof utterances[number]) => utterances.push(u) } });
  vi.stubGlobal("SpeechSynthesisUtterance", class { constructor(public text: string) {} });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("synthetic remote failure")));
  const oldEnd = vi.fn(), newEnd = vi.fn(), onError = vi.fn();
  const tts = getTTS();
  tts.speak("First sentence.", { onEnd: oldEnd, onError });
  await vi.waitFor(() => expect(utterances).toHaveLength(1));
  tts.stop();
  tts.speak("New sentence.", { onEnd: newEnd, onError });
  await vi.waitFor(() => expect(utterances).toHaveLength(2));
  utterances[0].onend?.();
  utterances[0].onerror?.({ error: "network" });
  expect(oldEnd).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(newEnd).not.toHaveBeenCalled();
  utterances[1].onend?.();
  expect(newEnd).toHaveBeenCalledOnce();
});
