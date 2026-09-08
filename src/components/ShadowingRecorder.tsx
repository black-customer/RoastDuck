"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { SpeakButton } from "./SpeakButton";
import {
  RECORDER_FALLBACK_COPY,
  classifyMediaError,
  initialRecorderState,
  pickMimeType,
  recorderReducer,
  type FallbackReason,
} from "@/lib/media/recorder-machine";

/** 等待用户点掉系统权限弹窗的上限；超时后允许用户直接降级跟读。 */
const PERMISSION_TIMEOUT_MS = 8000;

export function ShadowingRecorder({
  sentence,
  accent,
  disabled,
  showSourcePlayback = true,
  introTitle = "先听一次原音",
  introText = "听节奏和重音，再录下自己的模仿。",
  completeLabel = "可以继续",
  fallbackCompleteLabel = "我已自行跟读，可以继续",
  onComplete,
}: {
  sentence: string;
  accent: string;
  disabled?: boolean;
  showSourcePlayback?: boolean;
  introTitle?: string;
  introText?: string;
  completeLabel?: string;
  fallbackCompleteLabel?: string;
  onComplete: (result: {
    attempts: number;
    microphoneMode: "recorded" | "self_assessed";
    fallbackReason: FallbackReason | null;
  }) => void;
}) {
  const [state, dispatch] = useReducer(recorderReducer, initialRecorderState);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  /** 每次发起录音自增；只有最新请求的结果才会被采用，避免过期请求回填状态。 */
  const requestIdRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const releaseAudioUrl = useCallback(() => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
  }, []);

  const teardownStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const discardRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    chunksRef.current = [];
    if (!recorder) return;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    if (recorder.state === "recording") {
      try {
        recorder.stop();
      } catch {
        // 录音器可能已经由浏览器终止；清理引用即可。
      }
    }
  }, []);

  useEffect(() => {
    // 关键：必须在 effect 开头置 true。
    // 旧实现只在 cleanup 置 false 且从不重置，Strict Mode 双调用后永久为 false，
    // 导致授权成功后立刻被判定为「已卸载」而卡在 requesting。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      discardRecorder();
      teardownStream();
      releaseAudioUrl();
    };
  }, [discardRecorder, releaseAudioUrl, teardownStream]);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      dispatch({ type: "fallback", reason: "unsupported" });
      return;
    }

    const requestId = ++requestIdRef.current;
    dispatch({ type: "start_requested" });

    let stream: MediaStream;
    let requestExpired = false;
    const streamRequest = navigator.mediaDevices.getUserMedia({ audio: true }).then((nextStream) => {
      if (requestExpired || !mountedRef.current || requestId !== requestIdRef.current) {
        nextStream.getTracks().forEach((track) => track.stop());
        throw new DOMException("Stale microphone request", "AbortError");
      }
      return nextStream;
    });
    try {
      stream = await Promise.race([
        streamRequest,
        new Promise<never>((_, reject) => {
          timeoutRef.current = setTimeout(() => {
            const error = new DOMException("Microphone permission timed out", "AbortError");
            reject(error);
          }, PERMISSION_TIMEOUT_MS);
        }),
      ]);
    } catch (reason) {
      requestExpired = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      if (requestId !== requestIdRef.current) return;
      requestIdRef.current += 1;
      dispatch({ type: "fallback", reason: classifyMediaError(reason) });
      return;
    }

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;

    // 过期请求或组件已卸载：立刻释放刚拿到的麦克风，避免残留占用。
    if (!mountedRef.current || requestId !== requestIdRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    releaseAudioUrl();

    const failRecording = (reason: FallbackReason) => {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      requestIdRef.current += 1;
      discardRecorder();
      teardownStream();
      releaseAudioUrl();
      dispatch({ type: "fallback", reason });
    };

    // 设备被拔出/被其它程序独占时，音轨会结束；此时应降级而不是让 onstop 误产出空录音。
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener("ended", () => failRecording("device_error"), { once: true });
    });

    let recorder: MediaRecorder;
    try {
      const mimeType = pickMimeType(MediaRecorder.isTypeSupported?.bind(MediaRecorder)) || undefined;
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      failRecording("format_unsupported");
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      failRecording("device_error");
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      teardownStream();
      recorderRef.current = null;
      chunksRef.current = [];
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      if (blob.size === 0) {
        requestIdRef.current += 1;
        dispatch({ type: "fallback", reason: "device_error" });
        return;
      }
      const nextUrl = URL.createObjectURL(blob);
      audioUrlRef.current = nextUrl;
      dispatch({ type: "recording_stopped", audioUrl: nextUrl });
    };

    try {
      recorder.start();
      dispatch({ type: "recording_started" });
    } catch {
      failRecording("format_unsupported");
    }
  }, [discardRecorder, releaseAudioUrl, teardownStream]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const retry = useCallback(() => {
    releaseAudioUrl();
    dispatch({ type: "reset" });
  }, [releaseAudioUrl]);

  const phase = state.phase;
  const audioUrl = state.audioUrl;

  return (
    <div className="space-y-6">
      {showSourcePlayback ? (
        <div className="flex items-center gap-4 rounded-2xl bg-[var(--primary-soft)] p-4">
          <SpeakButton text={sentence} lang={accent} size="lg" />
          <div>
            <p className="font-semibold">{introTitle}</p>
            <p className="mt-1 text-sm text-[var(--muted)]">{introText}</p>
          </div>
        </div>
      ) : null}

      {phase === "fallback" ? (
        <div className="permission-state" role="status">
          <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5 shrink-0" aria-hidden="true">
            <path
              d="M12 8v4m0 4h.01M10.3 4.7 3.6 16.3A2 2 0 0 0 5.3 19h13.4a2 2 0 0 0 1.7-2.7L13.7 4.7a2 2 0 0 0-3.4 0Z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
          <p>{state.fallbackReason ? RECORDER_FALLBACK_COPY[state.fallbackReason] : null}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex min-h-28 items-center justify-center rounded-2xl border border-[var(--border)] bg-white p-5">
            {phase === "recorded" && audioUrl ? (
              <audio src={audioUrl} controls className="w-full" aria-label="回放我的录音" />
            ) : (
              <div className="text-center">
                <div className={phase === "recording" ? "recording-dot mx-auto" : "record-dot mx-auto"} />
                <p className="mt-3 text-sm text-[var(--muted)]">
                  {phase === "recording"
                    ? "正在录音，说完后点击停止"
                    : phase === "requesting"
                      ? "正在请求麦克风权限…"
                      : "录音只保留在当前页面内存中"}
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {phase === "recording" ? (
              <button type="button" className="secondary-button col-span-2" onClick={stopRecording}>
                <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                  <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
                </svg>
                停止录音
              </button>
            ) : phase === "recorded" ? (
              <>
                <button type="button" className="secondary-button" onClick={retry} disabled={disabled}>
                  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                    <path
                      d="M5 9V4m0 0h5M5 4l3.5 3.5A7 7 0 1 1 6 14"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  再来一次
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={disabled}
                  onClick={() =>
                    onComplete({
                      attempts: Math.max(1, state.attempts),
                      microphoneMode: "recorded",
                      fallbackReason: null,
                    })
                  }
                >
                  {completeLabel}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary-button col-span-2"
                onClick={() => void startRecording()}
                disabled={disabled || phase === "requesting"}
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
                  <path
                    d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4m-3 0h6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
                开始录音
              </button>
            )}
          </div>
        </div>
      )}

      {phase === "fallback" ? (
        <div className="space-y-3">
          <button
            type="button"
            className="primary-button w-full"
            disabled={disabled}
            onClick={() =>
              onComplete({
                attempts: Math.max(1, state.attempts),
                microphoneMode: "self_assessed",
                fallbackReason: state.fallbackReason,
              })
            }
          >
            {fallbackCompleteLabel}
          </button>
          <button
            type="button"
            className="secondary-button w-full"
            disabled={disabled}
            onClick={() => void startRecording()}
          >
            重新尝试录音
          </button>
        </div>
      ) : null}
    </div>
  );
}
