import { randomUUID } from "node:crypto";
import { DEEPSEEK_MODEL, type AiProvider, type StructuredAiRequest, type StructuredAiResult } from "./contracts";
import { AiProviderError } from "./errors";

export type MockAiResolver = (request: StructuredAiRequest<unknown>) => unknown | Promise<unknown>;

export class MockAiProvider implements AiProvider {
  readonly providerName = "mock" as const;
  readonly model = DEEPSEEK_MODEL;

  constructor(private readonly resolver: MockAiResolver) {}

  async generate<T>(request: StructuredAiRequest<T>): Promise<StructuredAiResult<T>> {
    const startedAt = Date.now();
    const value = await this.resolver(request as StructuredAiRequest<unknown>);
    const parsed = request.schema.safeParse(value);
    if (!parsed.success) throw new AiProviderError("Mock 输出未通过 Zod Schema", "invalid_output", false);
    return {
      data: parsed.data,
      responseId: `mock_${randomUUID()}`,
      latencyMs: Date.now() - startedAt,
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
    };
  }
}
