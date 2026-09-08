import { describe, expect, it, vi } from "vitest";
import { getSpeechHealth, readSpeechEnvironment } from "@/lib/speech/config";
import { MimoTtsProvider } from "@/lib/speech/mimo-provider";
import { SpeechProviderError } from "@/lib/speech/contracts";

function validWavBase64(): string {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(0, 40);
  return bytes.toString("base64");
}

describe("Xiaomi MiMo V2.5 TTS Provider", () => {
  it("Mock、E2E 与测试环境均在网络和缓存写入之前拦截真实合成", async () => {
    const { synthesizeSpeech } = await import("@/lib/speech/service");
    const network = vi.spyOn(globalThis, "fetch");
    try {
      for (const mode of ["mock", "e2e", "test"]) {
        vi.stubEnv("NODE_ENV", mode === "test" ? "test" : "production");
        vi.stubEnv("AI_PROVIDER", mode === "mock" ? "mock" : "deepseek");
        vi.stubEnv("ROASTDUCK_E2E", mode === "e2e" ? "1" : "0");
        await expect(synthesizeSpeech({ text: "Test only.", purpose: "example", accent: "en-US", rate: .95 })).rejects.toMatchObject({ code: "invalid_configuration", httpStatus: 503 });
      }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); vi.unstubAllEnvs(); }
  });
  it("默认锁定 mimo-v2.5-tts、Chloe 与美式英语", () => {
    const config = readSpeechEnvironment({ MIMO_API_KEY: "secret" });
    expect(config).toMatchObject({
      model: "mimo-v2.5-tts",
      voice: "Chloe",
      accent: "en-US",
      baseUrl: "https://api.xiaomimimo.com/v1",
    });
    expect(getSpeechHealth({})).toMatchObject({ configured: false, status: "missing_key" });
  });

  it("服务端按官方协议发送文本和美式风格指令，并校验 WAV", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify({
        id: "mimo_response_1",
        model: "mimo-v2.5-tts",
        choices: [{ message: { audio: { data: validWavBase64() } } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new MimoTtsProvider({ apiKey: "secret", fetchImpl: fetchImpl as typeof fetch });
    const result = await provider.synthesize({
      text: "I would rather work from home.",
      purpose: "learning_context",
      voice: "Chloe",
      accent: "en-US",
      rate: 0.95,
    });
    expect(result.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    const headers = init?.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("secret");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "mimo-v2.5-tts", audio: { format: "wav", voice: "Chloe" }, stream: false });
    expect(body.messages[0].content).toContain("General American English");
    expect(body.messages[1]).toEqual({ role: "assistant", content: "I would rather work from home." });
  });

  it("空 Key、错误鉴权和非 WAV 音频会给出可降级错误", async () => {
    expect(() => new MimoTtsProvider({ apiKey: "" })).toThrowError(SpeechProviderError);
    const unauthorized = new MimoTtsProvider({ apiKey: "secret", fetchImpl: vi.fn(async () => new Response("", { status: 401 })) as typeof fetch });
    await expect(unauthorized.synthesize({ text: "Hello", purpose: "example", voice: "Chloe", accent: "en-US", rate: 1 })).rejects.toMatchObject({ code: "authentication_failed", retryable: false });

    const invalid = new MimoTtsProvider({
      apiKey: "secret",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { audio: { data: Buffer.from("not-wav").toString("base64") } } }] }), { status: 200 })) as typeof fetch,
    });
    await expect(invalid.synthesize({ text: "Hello", purpose: "example", voice: "Chloe", accent: "en-US", rate: 1 })).rejects.toMatchObject({ code: "invalid_audio" });
  });
  it("收到HTTP头但接收音频正文超时不能误报音频损坏或成为可静默重发的失败",async()=>{
    const fetchImpl=vi.fn(async(_url:string|URL|Request,init?:RequestInit)=>new Response(new ReadableStream({
      start(stream){init?.signal?.addEventListener('abort',()=>stream.error(new DOMException('aborted','AbortError')),{once:true});},
    }),{status:200,headers:{'content-type':'application/json'}}));
    const provider=new MimoTtsProvider({apiKey:'synthetic-test-key',timeoutMs:20,fetchImpl:fetchImpl as typeof fetch});
    await expect(provider.synthesize({text:'Test only.',purpose:'example',voice:'Chloe',accent:'en-US',rate:1})).rejects.toMatchObject({code:'timeout',httpStatus:503});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
