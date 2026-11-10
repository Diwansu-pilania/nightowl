import { describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { createMockModel } from "../../test/mock-model";
import type { AppConfig } from "../config";
import { describeError, streamReply, toModelMessages, type ChatMessage } from "./chat";

const history: ChatMessage[] = [{ id: "1", role: "user", content: "hi" }];

describe("streamReply", () => {
    test("enforces the requested reply limit and reports length truncation", async () => {
        const model = createMockModel(["unfinished reply"], { finishReason: "length" });
        const result = await streamReply({ model, history, maxOutputTokens: 128,
            signal: new AbortController().signal, onText: () => {} });
        expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(128);
        expect(result.truncated).toBe(true);
    });
    test("delivers every text chunk in order", async () => {
        const model = createMockModel(["Hel", "lo", " there"]);
        let text = "";

        const result = await streamReply({
            model,
            history,
            signal: new AbortController().signal,
            onText: (delta) => (text += delta),
        });

        expect(text).toBe("Hello there");
        expect(result.aborted).toBe(false);
        // The model received our system prompt + the user's message.
        expect(model.doStreamCalls).toHaveLength(1);
    });

    test("throws when the stream reports an error", async () => {
        const model = createMockModel(["partial"], { error: new Error("boom") });

        await expect(
            streamReply({ model, history, signal: new AbortController().signal, onText: () => {} }),
        ).rejects.toThrow("boom");
    });

    test("stops early and reports aborted when the signal fires", async () => {
        const model = createMockModel(["a", "b", "c", "d", "e"], { chunkDelayInMs: 20 });
        const controller = new AbortController();
        let text = "";

        const result = await streamReply({
            model,
            history,
            signal: controller.signal,
            onText: (delta) => {
                text += delta;
                controller.abort(); // cancel after the first chunk
            },
        });

        expect(result.aborted).toBe(true);
        expect(text).toBe("a");
    });
});

describe("toModelMessages", () => {
    test("drops failed and empty assistant messages", () => {
        const messages: ChatMessage[] = [
            { id: "1", role: "user", content: "hi" },
            { id: "2", role: "assistant", content: "", error: "network down" },
            { id: "3", role: "user", content: "again" },
            { id: "4", role: "assistant", content: "" },
        ];

        expect(toModelMessages(messages)).toEqual([
            { role: "user", content: "hi" },
            { role: "user", content: "again" },
        ]);
    });
});

describe("describeError", () => {
    const ollama: AppConfig = { provider: "ollama", model: "llama3.2", baseURL: "http://localhost:11434/v1" };
    const openrouter: AppConfig = { provider: "openrouter", model: "x/y", baseURL: "https://openrouter.ai/api/v1", apiKey: "k" };

    const apiError = (statusCode: number) =>
        new APICallError({ message: "nope", url: "http://x", requestBodyValues: {}, statusCode });

    test("explains a missing Ollama model", () => {
        expect(describeError(apiError(404), ollama)).toContain("ollama pull llama3.2");
    });

    test("explains a bad API key", () => {
        expect(describeError(apiError(401), openrouter)).toContain("OPENROUTER_API_KEY");
    });

    test("explains Ollama not running", () => {
        expect(describeError(new Error("Unable to connect. Is the computer able to access the url?"), ollama)).toContain(
            "ollama serve",
        );
    });

    test("redacts the configured API key before an error can be displayed or saved", () => {
        const config = { ...openrouter, apiKey: "secret-test-key" };
        expect(describeError(new Error("upstream echoed secret-test-key"), config)).toBe("upstream echoed [redacted]");
    });
    test("explains context-limit errors without retrying or echoing request content", () => {
        const error = new APICallError({ message: "maximum context length exceeded", url: "http://x", requestBodyValues: {}, statusCode: 400 });
        expect(describeError(error, ollama)).toContain("/context");
    });
});
