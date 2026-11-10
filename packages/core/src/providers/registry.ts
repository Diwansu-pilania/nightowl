import { loadConfig, type AppConfig, type ProviderId } from "../config";
import type { ModelSelection } from "../sessions/types";
import { ProviderSettingsStore } from "./settings";
import { checkApiKey, checkModelId, ollamaURLs, OPENROUTER_BASE_URL } from "./urls";
import { selectionKey } from "../context/builder";

export type ModelInfo = ModelSelection & { name: string; contextLength?: number; maxOutputTokens?: number; tools?: boolean };
export type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;
type RegistryOptions = { env?: Record<string, string | undefined>; settings?: ProviderSettingsStore; fetcher?: Fetcher; timeoutMs?: number };

function object(value: unknown): Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The provider returned an unexpected response.");
    return value as Record<string, any>;
}
function positive(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Discovery/setup use provider-specific APIs; chat uses the existing compatible adapter. */
export class ProviderRegistry {
    private readonly env: Record<string, string | undefined>;
    readonly settings: ProviderSettingsStore;
    private readonly fetcher: Fetcher;
    private readonly timeoutMs: number;
    private runtimeKey?: string;
    private runtimeOllamaURL?: string;
    private cache = new Map<string, { time: number; models: ModelInfo[] }>();

    constructor(options: RegistryOptions = {}) {
        this.env = { ...(options.env ?? process.env) };
        this.settings = options.settings ?? new ProviderSettingsStore();
        this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
        this.timeoutMs = options.timeoutMs ?? 10_000;
    }

    get hasEnvironmentSelection() { return !!(this.env.NIGHTOWL_PROVIDER?.trim() || this.env.NIGHTOWL_MODEL?.trim()); }
    get hasConfiguration() {
        return this.hasEnvironmentSelection || !!(this.apiKey || this.env.OLLAMA_BASE_URL?.trim() || this.settings.load().defaultSelection);
    }
    get apiKey() { return this.runtimeKey ?? (this.env.OPENROUTER_API_KEY?.trim() || this.settings.readKey()); }
    get ollamaBaseURL() {
        return ollamaURLs(this.runtimeOllamaURL ?? (this.env.OLLAMA_BASE_URL?.trim() || this.settings.load().ollamaBaseURL || "http://localhost:11434/v1")).baseURL;
    }
    get credentialSource() {
        return this.runtimeKey ? "this run" : this.env.OPENROUTER_API_KEY?.trim() ? "environment" : this.settings.readKey() ? "local credentials file" : "not configured";
    }

    configFor = (selection: ModelSelection): AppConfig => {
        if (!["openrouter", "ollama"].includes(selection.provider)) throw new Error("Choose OpenRouter or Ollama.");
        const catalog = this.cache.get(`${OPENROUTER_BASE_URL}/models`)?.models.find((model) => model.model === selection.model);
        const limits = selection.provider === "openrouter"
            ? catalog?.contextLength ? { contextWindow: catalog.contextLength, maxOutputTokens: catalog.maxOutputTokens }
                : this.settings.load().modelLimits?.[selectionKey(selection)]
            : undefined;
        return {
            provider: selection.provider, model: checkModelId(selection.model),
            baseURL: selection.provider === "openrouter" ? OPENROUTER_BASE_URL : this.ollamaBaseURL,
            ...(selection.provider === "openrouter" ? { apiKey: this.apiKey } : {}),
            ...limits,
        };
    };

    initialConfig(): AppConfig {
        const settings = this.settings.load();
        const fallback = loadConfig({ ...this.env, OPENROUTER_API_KEY: this.apiKey });
        const saved = settings.defaultSelection;
        const provider = this.env.NIGHTOWL_PROVIDER?.trim() ? fallback.provider : saved?.provider ?? fallback.provider;
        const model = this.env.NIGHTOWL_MODEL?.trim() || (saved?.provider === provider ? saved.model : loadConfig({ NIGHTOWL_PROVIDER: provider }).model);
        return this.configFor({ provider, model });
    }

    private async json(url: string, signal?: AbortSignal, init: RequestInit = {}, key?: string): Promise<Record<string, any>> {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
            const response = await this.fetcher(url, { ...init, redirect: "error", signal: combined,
                headers: { ...(init.headers ?? {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
            if (!response.ok) {
                const provider = url.startsWith(OPENROUTER_BASE_URL) ? "OpenRouter" : "Ollama";
                if (response.status === 401 || response.status === 403) throw new Error(`${provider} rejected access. Check your API key or server permissions (${response.status}).`);
                if (response.status === 402) throw new Error("OpenRouter credits are unavailable. Add credits or select an Ollama model.");
                if (response.status === 429) throw new Error(`${provider} is rate limited. Wait and retry, or choose another provider.`);
                if (response.status === 404) throw new Error(`${provider} could not find the model or endpoint (404). Check the model ID and server URL.`);
                throw new Error(`${provider} returned HTTP ${response.status}. Try again later.`);
            }
            return object(await response.json());
        } catch (error) {
            if (signal?.aborted) throw new Error("Provider request cancelled.");
            if (timeout.aborted) throw new Error("The provider did not respond in time. Check the connection and retry.");
            if (error instanceof SyntaxError) throw new Error("The provider returned invalid JSON. Check the server URL.");
            // Do not echo URLs, response bodies, or arbitrary fetch errors that can contain credentials.
            if (error instanceof TypeError || (error instanceof Error && /ECONNREFUSED|Unable to connect|fetch failed|redirect/i.test(error.message))) {
                throw new Error(url.startsWith(OPENROUTER_BASE_URL) ? "Could not reach OpenRouter. Check your connection." : "Could not reach Ollama. Start it with ollama serve, or edit the server URL.");
            }
            const message = error instanceof Error ? error.message : "Provider request failed.";
            throw new Error(key ? message.split(key).join("[redacted]") : message);
        }
    }

    async configureKey(value: string, remember: boolean, signal?: AbortSignal) {
        const key = checkApiKey(value);
        await this.json(`${OPENROUTER_BASE_URL}/key`, signal, {}, key);
        signal?.throwIfAborted();
        if (remember) this.settings.saveKey(key);
        this.runtimeKey = key;
    }

    async configureOllama(value: string, signal?: AbortSignal) {
        const urls = ollamaURLs(value);
        const body = await this.json(`${urls.apiURL}/tags`, signal);
        if (!Array.isArray(body.models)) throw new Error("This server did not return an Ollama model list.");
        signal?.throwIfAborted();
        this.settings.update({ ollamaBaseURL: urls.baseURL });
        this.runtimeOllamaURL = urls.baseURL;
        this.cache.clear();
    }

    async models(provider: ProviderId, signal?: AbortSignal, refresh = false): Promise<ModelInfo[]> {
        const url = provider === "openrouter" ? `${OPENROUTER_BASE_URL}/models` : `${ollamaURLs(this.ollamaBaseURL).apiURL}/tags`;
        const cached = this.cache.get(url);
        if (!refresh && cached && Date.now() - cached.time < 5 * 60_000) return cached.models;
        const body = await this.json(url, signal);
        const entries: unknown = provider === "openrouter" ? body.data : body.models;
        if (!Array.isArray(entries)) throw new Error("The provider did not return a model list.");
        const models: ModelInfo[] = [];
        for (const entry of entries) {
            if (!entry || typeof entry !== "object") continue;
            const row = entry as Record<string, any>;
            const id = provider === "openrouter" ? row.id : row.name ?? row.model;
            if (typeof id !== "string") continue;
            try { checkModelId(id); } catch { continue; }
            if (provider === "openrouter" && Array.isArray(row.architecture?.output_modalities) && !row.architecture.output_modalities.includes("text")) continue;
            models.push({
                provider, model: id, name: typeof row.name === "string" ? row.name.replace(/[\x00-\x1f\x7f]/g, " ") : id,
                ...(provider === "openrouter" ? {
                    contextLength: positive(row.context_length) && row.context_length >= 1024 ? Math.min(2_000_000, Math.floor(row.context_length)) : undefined,
                    ...(positive(row.top_provider?.max_completion_tokens) ? { maxOutputTokens: Math.floor(row.top_provider.max_completion_tokens) } : {}),
                    tools: Array.isArray(row.supported_parameters) ? row.supported_parameters.includes("tools") : undefined,
                } : {}),
            });
        }
        const unique = [...new Map(models.map((model) => [model.model, model])).values()].sort((a, b) => a.model.localeCompare(b.model));
        this.cache.set(url, { time: Date.now(), models: unique });
        return unique;
    }

    async validate(selection: ModelSelection, signal?: AbortSignal): Promise<AppConfig> {
        const config = this.configFor(selection);
        if (selection.provider === "openrouter") {
            if (!config.apiKey) throw new Error("OpenRouter needs an API key. Configure it here or set OPENROUTER_API_KEY.");
            await this.json(`${OPENROUTER_BASE_URL}/key`, signal, {}, checkApiKey(config.apiKey));
        } else {
            await this.json(`${ollamaURLs(config.baseURL).apiURL}/show`, signal, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: config.model }),
            });
        }
        signal?.throwIfAborted();
        return config;
    }

    rememberSelection(selection: ModelSelection) {
        const config = this.configFor(selection);
        this.settings.update({
            defaultSelection: { provider: selection.provider, model: selection.model },
            ...(config.contextWindow ? { modelLimits: { ...this.settings.load().modelLimits,
                [selectionKey(selection)]: { contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens },
            } } : {}),
        });
    }
}
