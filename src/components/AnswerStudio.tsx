"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { QuestionDetail } from "@/lib/questions/service";
import type { AnswerInputLanguage } from "@/lib/answers/schemas";
import { getTTS } from "@/lib/tts";
import { InteractiveEnglishText } from "./InteractiveEnglishText";
import { LookupCard } from "./LookupCard";

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

const languageOptions: Array<{ value: AnswerInputLanguage; title: string; note: string }> = [
  { value: "zh", title: "中文", note: "先把真实想法说清楚" },
  { value: "en", title: "英文", note: "保留原意并自然修订" },
  { value: "mixed", title: "中英混合", note: "中文片段会成为表达 Gap" },
];

export function AnswerStudio({ question }: { question: QuestionDetail }) {
  const router = useRouter();
  const [lookupId, setLookupId] = useState<string | null>(null);
  const [language, setLanguage] = useState<AnswerInputLanguage>("mixed");
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [speechNote, setSpeechNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setSpeechSupported(Boolean(speechRecognitionConstructor()));
    return () => recognitionRef.current?.abort();
  }, []);

  function toggleSpeech() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setSpeechSupported(false);
      setSpeechNote("当前浏览器不支持网页听写。请按 Win + H 使用 Windows 听写，或直接键入。");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = language === "en" ? "en-GB" : "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    let committed = "";
    const before = text.trim();
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) committed += result[0].transcript;
        else interim += result[0].transcript;
      }
      const recognized = `${committed}${interim}`.trim();
      setText([before, recognized].filter(Boolean).join(before ? " " : ""));
    };
    recognition.onerror = (event) => {
      setListening(false);
      setSpeechNote(event.error === "not-allowed" ? "麦克风未授权。你仍可按 Win + H 或手工输入。" : "听写暂时中断，已经识别的文字不会丢失。可再次尝试。" );
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
      setSpeechNote("正在听写；你可以随时停止，录音本身不会保存。" );
    } catch {
      setSpeechNote("听写启动失败。请按 Win + H 或继续手工输入。" );
    }
  }

  async function submit() {
    if (!text.trim()) {
      setError("请先写下或说出你的回答。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/answers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId: crypto.randomUUID(), questionId: question.id, inputLanguage: language, rawText: text }),
      });
      const body = (await response.json()) as { answer?: { id: string }; error?: string };
      if (!response.ok || !body.answer) throw new Error(body.error || "回答保存失败");
      router.push(`/answer-studio/${encodeURIComponent(body.answer.id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "回答保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="studio-shell">
      <div className="studio-frame">
        <header className="studio-header">
          <Link href={`/questions/${encodeURIComponent(question.id)}`} className="exit-button">← 返回题目</Link>
          <span>原文优先保存 · AI 不会覆盖</span>
        </header>
        {error ? <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div> : null}
        <div className="studio-layout">
          <aside className="studio-question-panel">
            {question.textEn.trim() ? <InteractiveEnglishText content={question.interactiveQuestion} onLookup={setLookupId} className="studio-question-title" /> : <p className="studio-question-title">历史回答 · 原始问句缺失</p>}
            <p>Part {question.part}</p>
            <p>{question.textZh || "中文题干尚未补全"}</p>
            <button type="button" className="studio-play" disabled={!question.textEn.trim()} onClick={() => getTTS().speak(question.textEn, { lang: "en-US" })}>播放题目</button>
          </aside>
          <section className="studio-editor-panel">
            <div className="studio-editor-heading"><h1>把真实想法说出来</h1><small>{text.length} / 8000</small></div>
            <div className="studio-language-tabs" aria-label="回答语言">
              {languageOptions.map((option) => <button key={option.value} type="button" aria-pressed={language === option.value} onClick={() => setLanguage(option.value)}><strong>{option.title}</strong><span>{option.note}</span></button>)}
            </div>
            <label className="studio-textarea-label" htmlFor="answer-draft">你的回答</label>
            <textarea id="answer-draft" value={text} maxLength={8000} onChange={(event) => setText(event.target.value)} placeholder={language === "en" ? "Speak naturally. It does not need to be perfect…" : language === "zh" ? "先写你真正想表达的内容，不必翻译……" : "想到英文就说英文，卡住时直接用中文继续……"} />
            <div className="studio-dictation">
              <button type="button" className={listening ? "is-listening" : ""} aria-pressed={listening} onClick={toggleSpeech}>{listening ? "停止听写" : "开始语音听写"}</button>
              <p>{speechNote || (speechSupported ? "支持浏览器听写；也可把光标放在文本框后按 Win + H。" : "请按 Win + H 使用 Windows 听写，或直接键入。")}</p>
            </div>
            <div className="studio-submit-row"><p>提交后先保存原文，再创建 DeepSeek V4 Flash 处理任务。</p><button type="button" className="primary-button" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? "正在保存…" : "保存并生成个人材料"}</button></div>
          </section>
        </div>
      </div>
      <LookupCard annotationId={lookupId} onClose={() => setLookupId(null)} />
    </div>
  );
}
