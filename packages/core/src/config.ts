/**
 * App configuration: which AI provider + model NightOwl talks to.
 *
 * Environment defaults for provider configuration. ProviderRegistry layers
 * saved preferences and in-app setup over these values. Source runs use Bun's
 * normal `.env` loading; compiled builds require explicit environment values
 * or setup. API keys never belong in source code or conversation records.
 *
 *   NIGHTOWL_PROVIDER   "openrouter" | "ollama"   (optional, auto-detected)
 *   NIGHTOWL_MODEL      model id for that provider (optional, has a default)
 *   OPENROUTER_API_KEY  required for OpenRouter
 *   OLLAMA_BASE_URL     optional, defaults to http://localhost:11434/v1
 */

export const PROVIDERS = ["openrouter", "ollama"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export type AppConfig = {
    provider: ProviderId;
    model: string;
    /** Root URL of the provider's OpenAI-compatible API. */
    baseURL: string;
    apiKey?: string;
    /** Known provider limits, when discovered. Ollama's effective window is user configured. */
    contextWindow?: number;
    maxOutputTokens?: number;
};

/**
 * Both providers speak the same "OpenAI-compatible" HTTP API, so the only
 * things that differ between them are the URL and a sensible default model.
 */
const PROVIDER_DEFAULTS: Record<ProviderId, { baseURL: string; model: string }> = {
    openrouter: {
        baseURL: "https://openrouter.ai/api/v1",
        model: "anthropic/claude-sonnet-5.5",
    },
    ollama: {
        baseURL: "http://localhost:11434/v1",
        model: "llama3.2",
    },
};

type Env = Record<string, string | undefined>;

function isProviderId(value: string): value is ProviderId {
    return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Builds the config from environment variables.
 *
 * `env` is a parameter (defaulting to the real `process.env`) so tests can
 * pass a fake environment instead of mutating global state.
 *
 * Provider choice:
 *   1. NIGHTOWL_PROVIDER if it's set to a known provider
 *   2. otherwise OpenRouter if an OpenRouter key exists
 *   3. otherwise local Ollama (works offline, no key needed)
 */
export function loadConfig(env: Env = process.env): AppConfig {
    const requested = env.NIGHTOWL_PROVIDER?.trim().toLowerCase();
    const provider: ProviderId =
        requested && isProviderId(requested)
            ? requested
            : env.OPENROUTER_API_KEY
              ? "openrouter"
              : "ollama";

    const defaults = PROVIDER_DEFAULTS[provider];
    const baseURL =
        provider === "ollama" ? (env.OLLAMA_BASE_URL?.trim() || defaults.baseURL) : defaults.baseURL;

    return {
        provider,
        model: env.NIGHTOWL_MODEL?.trim() || defaults.model,
        baseURL,
        apiKey: provider === "openrouter" ? env.OPENROUTER_API_KEY?.trim() || undefined : undefined,
    };
}

/**
 * Returns a human-readable problem with the config, or null if it looks
 * usable. We report problems in the UI instead of crashing at startup.
 */
export function getConfigProblem(config: AppConfig, env: Env = process.env): string | null {
    const requested = env.NIGHTOWL_PROVIDER?.trim();
    if (requested && !isProviderId(requested.toLowerCase())) {
        return `Unknown NIGHTOWL_PROVIDER "${requested}". Use one of: ${PROVIDERS.join(", ")}.`;
    }
    if (config.provider === "openrouter" && !config.apiKey) {
        return "OPENROUTER_API_KEY is not set. Use /models to enter a key, or set it in your environment.";
    }
    return null;
}
