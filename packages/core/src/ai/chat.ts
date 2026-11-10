import { APICallError, streamText, type LanguageModel, type ModelMessage } from "ai";
import type { AppConfig } from "../config";

import type { ChatMessage } from "../sessions/types";
export type { ChatMessage } from "../sessions/types";

export const SYSTEM_PROMPT = [
    "You are NightOwl, a helpful AI coding assistant running in the user's terminal.",
    "Be concise and direct. Markdown headings, lists, and fenced code blocks are supported.",
].join(" ");

/**
 * Converts UI messages into the format the AI SDK sends to the model.
 * Failed/empty answers are excluded. Partial answers are explicitly marked
 * so a later request doesn't present interrupted work as a completed reply.
 */
export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
    return messages
        .filter((m) => !m.error && m.content.trim().length > 0)
        .map((m) => ({
            role: m.role,
            content: m.interrupted ? `${m.content}\n[This response was interrupted before it finished.]` : m.content,
        }));
}

type StreamReplyOptions = {
    model: LanguageModel;
    history: ChatMessage[];
    signal: AbortSignal;
    maxOutputTokens?: number;
    /** Called for every chunk of text as it arrives. */
    onText: (delta: string) => void;
};

/**
 * Streams one assistant reply.
 *
 * Resolves when the reply is finished, resolves with `aborted: true` if the
 * user cancelled, and throws if the request failed.
 */
export async function streamReply({
    model,
    history,
    signal,
    onText,
    maxOutputTokens,
}: StreamReplyOptions): Promise<{ aborted: boolean; truncated?: boolean }> {
    const result = streamText({
        model,
        instructions: SYSTEM_PROMPT,
        messages: toModelMessages(history),
        abortSignal: signal,
        maxOutputTokens,
        // Never transparently start a second paid attempt or duplicate a partial response.
        maxRetries: 0,
        // By default the SDK `console.error`s failures, which would print
        // garbage over our terminal UI. We handle errors from the stream
        // ourselves (the "error" case below), so silence the default.
        onError: () => {},
    });

    let truncated = false;
    try {
        // `fullStream` yields typed events. We only need three of them now;
        // tool calls, reasoning, etc. will matter in later phases.
        for await (const part of result.fullStream) {
            switch (part.type) {
                case "text-delta":
                    onText(part.text);
                    break;
                case "error":
                    throw part.error;
                case "abort":
                    return { aborted: true };
                case "finish":
                    truncated = part.finishReason === "length";
                    break;
            }
        }
    } catch (error) {
        // Depending on timing, cancelling can surface as a thrown AbortError
        // instead of an "abort" event — treat both the same way.
        if (signal.aborted) return { aborted: true };
        throw error;
    }

    return { aborted: signal.aborted, truncated };
}

/** Turns any thrown error into a short message a user can act on. */
export function describeError(error: unknown, config: AppConfig): string {
    const description = describeProviderError(error, config);
    return config.apiKey ? description.split(config.apiKey).join("[redacted]") : description;
}

function describeProviderError(error: unknown, config: AppConfig): string {
    const message = error instanceof Error ? error.message : String(error);

    if (APICallError.isInstance(error)) {
        if ((error.statusCode === 400 || error.statusCode === 413) && /context|token.{0,30}(limit|maximum|exceed)|maximum.{0,30}token/i.test(message)) {
            return "The provider rejected the context size. Use /context to lower the input window or reply limit, /compact to reduce older turns, or /models to choose another model. Your conversation is saved.";
        }
        if (error.statusCode === 401) {
            return `${config.provider} rejected the API key (401). Check OPENROUTER_API_KEY.`;
        }
        if (error.statusCode === 404) {
            return config.provider === "ollama"
                ? `Model "${config.model}" isn't installed in Ollama. Run: ollama pull ${config.model}`
                : `Model "${config.model}" wasn't found on ${config.provider} (404). Check NIGHTOWL_MODEL.`;
        }
        if (error.statusCode === 402) return "OpenRouter credits are unavailable. Use /models to switch providers, or add credits and try again.";
        if (error.statusCode === 429) return `${config.provider} is rate limited. Wait and retry, or use /models to choose another provider.`;
        if (error.statusCode !== undefined) {
            return `${config.provider} returned ${error.statusCode}: ${message}`;
        }
    }

    // A refused connection to Ollama almost always means it isn't running.
    if (config.provider === "ollama" && /ECONNREFUSED|Unable to connect|fetch failed/i.test(message)) {
        return `Couldn't reach Ollama at ${config.baseURL}. Is it running? Start it with: ollama serve`;
    }

    return message;
}
