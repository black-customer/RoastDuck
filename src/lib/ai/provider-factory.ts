import { readAiEnvironment } from "./config";
import type { AiProvider } from "./contracts";
import { DeepSeekProvider } from "./deepseek-provider";
import { MockAiProvider, type MockAiResolver } from "./mock-provider";

export function createAiProvider(options: { mockResolver?: MockAiResolver } = {}): AiProvider {
  const config = readAiEnvironment();
  if (config.provider === "mock") {
    if (!options.mockResolver) throw new Error("AI_PROVIDER=mock 时必须显式提供 Mock resolver");
    return new MockAiProvider(options.mockResolver);
  }
  return new DeepSeekProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl });
}
