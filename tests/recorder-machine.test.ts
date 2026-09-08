import { describe, expect, it } from "vitest";
import {
  classifyMediaError,
  initialRecorderState,
  pickMimeType,
  recorderReducer,
  type RecorderEvent,
  type RecorderState,
} from "@/lib/media/recorder-machine";

function drive(events: RecorderEvent[], from: RecorderState = initialRecorderState): RecorderState {
  return events.reduce(recorderReducer, from);
}

describe("录音状态机", () => {
  it("完整路径：请求授权 → 录音 → 停止后进入 recorded", () => {
    const state = drive([
      { type: "start_requested" },
      { type: "recording_started" },
      { type: "recording_stopped", audioUrl: "blob:abc" },
    ]);
    expect(state.phase).toBe("recorded");
    expect(state.audioUrl).toBe("blob:abc");
    expect(state.attempts).toBe(1);
  });

  it("requesting / recording 期间重复 start 不叠加次数，也不覆盖状态", () => {
    const requesting = drive([{ type: "start_requested" }]);
    const again = recorderReducer(requesting, { type: "start_requested" });
    expect(again).toBe(requesting);
    expect(again.attempts).toBe(1);

    const recording = drive([{ type: "start_requested" }, { type: "recording_started" }]);
    const againRecording = recorderReducer(recording, { type: "start_requested" });
    expect(againRecording).toBe(recording);
  });

  it("任何阶段都能降级，且清空音频", () => {
    const recorded = drive([
      { type: "start_requested" },
      { type: "recording_started" },
      { type: "recording_stopped", audioUrl: "blob:abc" },
    ]);
    const fallen = recorderReducer(recorded, { type: "fallback", reason: "device_error" });
    expect(fallen.phase).toBe("fallback");
    expect(fallen.fallbackReason).toBe("device_error");
    expect(fallen.audioUrl).toBeNull();
  });

  it("reset 清空音频与降级原因但保留累计次数", () => {
    const state = drive([
      { type: "start_requested" },
      { type: "fallback", reason: "timeout" },
      { type: "start_requested" },
      { type: "recording_started" },
      { type: "recording_stopped", audioUrl: "blob:abc" },
      { type: "reset" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.audioUrl).toBeNull();
    expect(state.fallbackReason).toBeNull();
    expect(state.attempts).toBe(2);
  });

  it("非 recording 阶段收到 recording_stopped 不改变状态", () => {
    const idle = recorderReducer(initialRecorderState, {
      type: "recording_stopped",
      audioUrl: "blob:x",
    });
    expect(idle).toBe(initialRecorderState);
  });
});

describe("错误分类", () => {
  it("权限拒绝归为 permission_denied", () => {
    expect(classifyMediaError(new DOMException("", "NotAllowedError"))).toBe("permission_denied");
    expect(classifyMediaError(new DOMException("", "SecurityError"))).toBe("permission_denied");
  });

  it("设备缺失/占用/不可读归为 device_error", () => {
    expect(classifyMediaError(new DOMException("", "NotFoundError"))).toBe("device_error");
    expect(classifyMediaError(new DOMException("", "NotReadableError"))).toBe("device_error");
    expect(classifyMediaError(new DOMException("", "OverconstrainedError"))).toBe("device_error");
  });

  it("超时归为 timeout", () => {
    expect(classifyMediaError(new DOMException("", "AbortError"))).toBe("timeout");
  });

  it("未知异常一律按设备错误处理，不静默成功", () => {
    expect(classifyMediaError(new Error("boom"))).toBe("device_error");
    expect(classifyMediaError(undefined)).toBe("device_error");
  });
});

describe("录音格式探测", () => {
  it("按优先级挑选第一个受支持的格式", () => {
    expect(pickMimeType((type) => type === "audio/webm")).toBe("audio/webm");
    expect(pickMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
  });

  it("全不支持时返回空串交由浏览器默认", () => {
    expect(pickMimeType(() => false)).toBe("");
  });

  it("浏览器不提供 isTypeSupported 时交由浏览器使用默认格式", () => {
    expect(pickMimeType(undefined)).toBe("");
  });
});
