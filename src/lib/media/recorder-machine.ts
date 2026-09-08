/**
 * 录音状态机（纯函数，可在单元测试中直接驱动，不依赖浏览器 API）。
 *
 * 状态：idle → requesting → recording → recorded
 *                    ↘ fallback（permission_denied / unsupported / device_error / timeout / format_unsupported）
 */

export const RECORDER_PHASES = ["idle", "requesting", "recording", "recorded", "fallback"] as const;
export type RecorderPhase = (typeof RECORDER_PHASES)[number];

export const FALLBACK_REASONS = [
  "permission_denied",
  "unsupported",
  "device_error",
  "timeout",
  "format_unsupported",
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export interface RecorderState {
  phase: RecorderPhase;
  attempts: number;
  fallbackReason: FallbackReason | null;
  audioUrl: string | null;
}

export type RecorderEvent =
  | { type: "start_requested" }
  | { type: "recording_started" }
  | { type: "recording_stopped"; audioUrl: string }
  | { type: "fallback"; reason: FallbackReason }
  | { type: "reset" };

export const initialRecorderState: RecorderState = {
  phase: "idle",
  attempts: 0,
  fallbackReason: null,
  audioUrl: null,
};

export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case "start_requested":
      // 只有 idle / recorded（重录）/ fallback（再次尝试）才能发起新请求。
      if (state.phase === "requesting" || state.phase === "recording") return state;
      return { phase: "requesting", attempts: state.attempts + 1, fallbackReason: null, audioUrl: state.audioUrl };

    case "recording_started":
      if (state.phase !== "requesting") return state;
      return { ...state, phase: "recording" };

    case "recording_stopped":
      if (state.phase !== "recording") return state;
      return { ...state, phase: "recorded", audioUrl: event.audioUrl };

    case "fallback":
      return { phase: "fallback", attempts: state.attempts, fallbackReason: event.reason, audioUrl: null };

    case "reset":
      return { ...initialRecorderState, attempts: state.attempts };

    default:
      return state;
  }
}

/** 把浏览器异常映射为降级原因。未知错误一律按设备错误处理。 */
export function classifyMediaError(reason: unknown): FallbackReason {
  const name = reason instanceof DOMException ? reason.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return "permission_denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "NotReadableError":
    case "TrackStartError":
      return "device_error";
    case "AbortError":
      return "timeout";
    default:
      return "device_error";
  }
}

/** 按顺序挑选浏览器支持的录音格式；无法探测或都不支持时交由浏览器选择默认格式。 */
const CANDIDATE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

export function pickMimeType(isTypeSupported?: (type: string) => boolean): string {
  if (typeof isTypeSupported !== "function") return "";
  for (const type of CANDIDATE_MIME_TYPES) {
    if (isTypeSupported(type)) return type;
  }
  return "";
}

export const RECORDER_FALLBACK_COPY: Record<FallbackReason, string> = {
  permission_denied: "麦克风权限被拒绝。你仍可播放原音并自行跟读，本轮会记录为自评降级。",
  unsupported: "当前浏览器不支持页面内录音。请自行跟读后继续。",
  device_error: "没有检测到可用的录音设备。请自行跟读后继续。",
  timeout: "等待麦克风权限超时。请检查系统弹窗后重试，或直接自行跟读。",
  format_unsupported: "浏览器没有可用的录音格式。请自行跟读后继续。",
};
