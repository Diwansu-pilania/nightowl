import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

export function temporaryDatabase() {
    const prefix = join(tmpdir(), "nightowl-test-");
    const directory = mkdtempSync(prefix);
    return {
        path: join(directory, "sessions.sqlite"),
        cleanup: () => {
            const target = resolve(directory);
            if (!target.startsWith(resolve(prefix)) || target === resolve(tmpdir())) throw new Error("Unsafe test cleanup path");
            rmSync(target, { recursive: true, force: true });
        },
    };
}

export function mockModel(chunks: string[], delay: number | null = null) {
    return new MockLanguageModelV4({
        provider: "mock", modelId: "test-model",
        doStream: async () => ({ stream: simulateReadableStream({
            chunkDelayInMs: delay,
            chunks: [
                { type: "stream-start" as const, warnings: [] },
                { type: "text-start" as const, id: "text" },
                ...chunks.map((delta) => ({ type: "text-delta" as const, id: "text", delta })),
                { type: "text-end" as const, id: "text" },
                { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: {
                    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: chunks.length, text: chunks.length, reasoning: 0 },
                } },
            ],
        }) }),
    });
}

export async function until(predicate: () => boolean, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the session");
        await Bun.sleep(5);
    }
}
