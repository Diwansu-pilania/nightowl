import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { AppConfig } from "../config";
import { OPENROUTER_BASE_URL, ollamaURLs } from "../providers/urls";

/**
 * Turns our config into an AI SDK `LanguageModel`.
 *
 * OpenRouter and Ollama both implement the OpenAI Chat Completions HTTP API,
 * so one adapter (`@ai-sdk/openai-compatible`) handles both — only the base
 * URL and API key change. The rest of the app only ever sees the generic
 * `LanguageModel` interface, so it doesn't care which provider is behind it.
 */
export function createModel(config: AppConfig, fetcher: typeof fetch = fetch): LanguageModel {
    if (config.provider === "openrouter" && config.baseURL !== OPENROUTER_BASE_URL) {
        throw new Error("OpenRouter credentials can only be used with the official OpenRouter API.");
    }
    const provider = createOpenAICompatible({
        name: config.provider,
        baseURL: config.provider === "ollama" ? ollamaURLs(config.baseURL).baseURL : config.baseURL,
        apiKey: config.provider === "openrouter" ? config.apiKey : undefined,
        fetch: Object.assign(
            (url: RequestInfo | URL, options?: RequestInit) => fetcher(url, { ...options, redirect: "error" }),
            { preconnect: fetcher.preconnect },
        ),
        // Ask the server to report token usage at the end of the stream
        // (we'll use this later for /usage).
        includeUsage: true,
        // Optional OpenRouter header that names the app on their dashboard.
        headers: config.provider === "openrouter" ? { "X-Title": "NightOwl" } : undefined,
    });

    return provider(config.model);
}
