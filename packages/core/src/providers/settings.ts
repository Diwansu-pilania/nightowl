import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ModelSelection } from "../sessions/types";
import { checkApiKey, checkModelId, ollamaURLs } from "./urls";

export type ModelLimits = { contextWindow: number; maxOutputTokens?: number };
export type ProviderSettings = { version: 1; defaultSelection?: ModelSelection; ollamaBaseURL?: string; modelLimits?: Record<string, ModelLimits> };

/** User-level preferences and optional credentials, never stored inside a conversation. */
export class ProviderSettingsStore {
    private settings: ProviderSettings = { version: 1 };
    private key: string | undefined;
    constructor(readonly directory?: string) {}

    private read(name: string): unknown {
        if (!this.directory) return undefined;
        const path = join(this.directory, name);
        if (!existsSync(path)) return undefined;
        try { return JSON.parse(readFileSync(path, "utf8")); }
        catch { throw new Error(`Could not read ${name} in the NightOwl data directory. Fix the file before changing provider settings.`); }
    }

    private write(name: string, value: unknown) {
        if (!this.directory) return;
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const temporary = join(this.directory, `.${name}.${crypto.randomUUID()}.tmp`);
        try {
            writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
            renameSync(temporary, join(this.directory, name));
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }

    load(): ProviderSettings {
        const value = this.read("settings.json") ?? this.settings;
        if (!value || typeof value !== "object" || (value as ProviderSettings).version !== 1) throw new Error("Unsupported NightOwl settings format.");
        const data = value as ProviderSettings;
        const result: ProviderSettings = { version: 1 };
        if (data.defaultSelection) {
            if (!["openrouter", "ollama"].includes(data.defaultSelection.provider) || typeof data.defaultSelection.model !== "string") {
                throw new Error("Invalid default provider/model in NightOwl settings.");
            }
            result.defaultSelection = { provider: data.defaultSelection.provider, model: checkModelId(data.defaultSelection.model) };
        }
        if (data.ollamaBaseURL !== undefined) {
            if (typeof data.ollamaBaseURL !== "string") throw new Error("Invalid Ollama URL in NightOwl settings.");
            result.ollamaBaseURL = ollamaURLs(data.ollamaBaseURL).baseURL;
        }
        if (data.modelLimits !== undefined) {
            if (!data.modelLimits || typeof data.modelLimits !== "object" || Array.isArray(data.modelLimits)) throw new Error("Invalid saved model limits.");
            result.modelLimits = {};
            for (const [key, limits] of Object.entries(data.modelLimits)) {
                if (!limits || !Number.isSafeInteger(limits.contextWindow) || limits.contextWindow < 1024 || limits.contextWindow > 2_000_000 ||
                    (limits.maxOutputTokens !== undefined && (!Number.isSafeInteger(limits.maxOutputTokens) || limits.maxOutputTokens < 1))) {
                    throw new Error("Invalid saved model limits.");
                }
                result.modelLimits[key] = { contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens };
            }
        }
        return result;
    }

    update(patch: Omit<Partial<ProviderSettings>, "version">) {
        const next = { ...this.load(), ...patch, version: 1 as const };
        this.write("settings.json", next);
        this.settings = next;
    }

    readKey(): string | undefined {
        const value = this.read("credentials.json");
        if (value === undefined) return this.key;
        if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 ||
            typeof (value as { openrouter?: unknown }).openrouter !== "string") throw new Error("Invalid NightOwl credentials file.");
        return checkApiKey((value as { openrouter: string }).openrouter);
    }

    saveKey(value: string) {
        const key = checkApiKey(value);
        this.write("credentials.json", { version: 1, openrouter: key });
        this.key = key;
    }
}
