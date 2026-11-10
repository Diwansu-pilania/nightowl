import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

type MockOptions = {
    /** Delay between chunks, so tests can cancel mid-stream. */
    chunkDelayInMs?: number;
    /** Emit an error event instead of finishing normally. */
    error?: Error;
    finishReason?: "stop" | "length";
};

/**
 * A fake LanguageModel that "streams" the given text chunks, exactly like a
 * real provider would, but without any network calls or API key.
 */
export function createMockModel(chunks: string[], options: MockOptions = {}) {
    const finish = {
        type: "finish" as const,
        finishReason: { unified: options.finishReason ?? "stop", raw: options.finishReason ?? "stop" },
        usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: chunks.length, text: chunks.length, reasoning: 0 },
        },
    };

    return new MockLanguageModelV4({
        provider: "mock",
        modelId: "mock-model",
        doStream: async () => ({
            stream: simulateReadableStream({
                chunkDelayInMs: options.chunkDelayInMs ?? null,
                chunks: [
                    { type: "stream-start" as const, warnings: [] },
                    { type: "text-start" as const, id: "t1" },
                    ...chunks.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
                    options.error
                        ? { type: "error" as const, error: options.error }
                        : { type: "text-end" as const, id: "t1" },
                    finish,
                ],
            }),
        }),
    });
}
