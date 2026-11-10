import { afterEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ProviderRegistry, type Fetcher } from "./registry";
import { ProviderSettingsStore } from "./settings";
import { OPENROUTER_BASE_URL, ollamaURLs } from "./urls";
import { temporaryDatabase } from "../test/fixtures";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const ok = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("provider discovery and setup", () => {
    test("local discovery never contacts the cloud or sends an OpenRouter key", async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const registry = new ProviderRegistry({ env: { OPENROUTER_API_KEY: "cloud-secret", OLLAMA_BASE_URL: "http://gpu-box:11434/proxy/v1" },
            fetcher: async (url, init) => { calls.push({ url, init }); return ok({ models: [{ name: "qwen:test" }] }); },
        });
        expect((await registry.models("ollama"))[0]?.model).toBe("qwen:test");
        await registry.models("ollama");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("http://gpu-box:11434/proxy/api/tags");
        expect(new Headers(calls[0]?.init?.headers).has("Authorization")).toBe(false);
        expect(calls[0]?.init?.redirect).toBe("error");
        expect(registry.configFor({ provider: "ollama", model: "qwen:test" }).apiKey).toBeUndefined();
        await registry.models("ollama", undefined, true);
        expect(calls).toHaveLength(2);
    });

    test("normalizes cloud catalog capabilities and validates the key only at the official origin", async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const registry = new ProviderRegistry({ env: { OPENROUTER_API_KEY: "test-key" }, fetcher: async (url, init) => {
            calls.push({ url, init });
            return ok(url.endsWith("/models") ? { data: [
                { id: "vendor/model", name: "Example", context_length: 32000, supported_parameters: ["tools"], architecture: { output_modalities: ["text"] } },
                { id: "image-only", architecture: { output_modalities: ["image"] } },
            ] } : { data: { label: "test" } });
        } });
        expect(await registry.models("openrouter")).toEqual([{ provider: "openrouter", model: "vendor/model", name: "Example", contextLength: 32000, tools: true }]);
        expect(new Headers(calls[0]?.init?.headers).has("Authorization")).toBe(false);
        await registry.validate({ provider: "openrouter", model: "vendor/model" });
        expect(calls[1]?.url).toBe(`${OPENROUTER_BASE_URL}/key`);
        expect(new Headers(calls[1]?.init?.headers).get("Authorization")).toBe("Bearer test-key");
        expect(calls[1]?.init?.redirect).toBe("error");
    });

    test("keys persist only when requested, separately from preferences", async () => {
        const temp = temporaryDatabase(); cleanup.push(temp.cleanup);
        const settings = new ProviderSettingsStore(dirname(temp.path));
        const registry = new ProviderRegistry({ settings, env: {}, fetcher: async () => ok({ data: {} }) });
        await registry.configureKey("ephemeral-test-key", false);
        expect(registry.apiKey).toBe("ephemeral-test-key");
        expect(existsSync(join(dirname(temp.path), "credentials.json"))).toBe(false);
        await registry.configureKey("saved-test-key", true);
        registry.rememberSelection({ provider: "openrouter", model: "vendor/model" });
        expect(readFileSync(join(dirname(temp.path), "settings.json"), "utf8")).not.toContain("saved-test-key");
        const reopened = new ProviderRegistry({ settings: new ProviderSettingsStore(dirname(temp.path)), env: {} });
        expect(reopened.apiKey).toBe("saved-test-key");
        expect(reopened.initialConfig().model).toBe("vendor/model");
        const envOverride = new ProviderRegistry({ settings, env: { OPENROUTER_API_KEY: "env-key", NIGHTOWL_PROVIDER: "ollama", NIGHTOWL_MODEL: "local-model" } });
        expect(envOverride.apiKey).toBe("env-key");
        expect(envOverride.initialConfig()).toMatchObject({ provider: "ollama", model: "local-model" });
        expect(envOverride.initialConfig().apiKey).toBeUndefined();
    });

    test("failed or cancelled key verification never changes stored credentials", async () => {
        const settings = new ProviderSettingsStore();
        settings.saveKey("old-key");
        const rejected = new ProviderRegistry({ settings, env: {}, fetcher: async () => new Response("new-key", { status: 401 }) });
        await expect(rejected.configureKey("new-key", true)).rejects.toThrow("rejected access");
        expect(settings.readKey()).toBe("old-key");
        const abort = new AbortController();
        const cancelled = new ProviderRegistry({ settings, env: {}, fetcher: async () => { abort.abort(); return ok({}); } });
        await expect(cancelled.configureKey("new-key", true, abort.signal)).rejects.toThrow();
        expect(settings.readKey()).toBe("old-key");
    });

    test("Ollama URL setup checks the server and model details without inference", async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const registry = new ProviderRegistry({ env: {}, fetcher: async (url, init) => {
            calls.push({ url, init }); return ok(url.endsWith("/tags") ? { models: [] } : { capabilities: ["completion"] });
        } });
        await registry.configureOllama("http://localhost:12434");
        expect(registry.ollamaBaseURL).toBe("http://localhost:12434/v1");
        await registry.validate({ provider: "ollama", model: "installed" });
        expect(calls.map((c) => c.url)).toEqual(["http://localhost:12434/api/tags", "http://localhost:12434/api/show"]);
        expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({ model: "installed" });
        expect(() => ollamaURLs("http://secret@localhost:11434")).toThrow("without embedded credentials");
    });

    test("reports provider limits, malformed responses, and timeouts without exposing keys", async () => {
        for (const [status, text] of [[402, "credits"], [429, "rate limited"], [500, "HTTP 500"]] as const) {
            const registry = new ProviderRegistry({ env: { OPENROUTER_API_KEY: "secret-key" }, fetcher: async () => new Response("secret-key", { status }) });
            await expect(registry.validate({ provider: "openrouter", model: "x" })).rejects.toThrow(text);
        }
        const malformed = new ProviderRegistry({ env: {}, fetcher: async () => ok({ error: "bad" }) });
        await expect(malformed.models("ollama")).rejects.toThrow("model list");
        const timeoutFetcher: Fetcher = async (_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        const timeout = new ProviderRegistry({ env: {}, fetcher: timeoutFetcher, timeoutMs: 10 });
        await expect(timeout.models("ollama")).rejects.toThrow("did not respond in time");
    });

    test("catalog context and output limits survive restart without cloud discovery in local mode", async () => {
        const settings = new ProviderSettingsStore();
        const registry = new ProviderRegistry({ settings, env: {}, fetcher: async () => ok({ data: [
            { id: "known", context_length: 64000, top_provider: { max_completion_tokens: 2000 } },
        ] }) });
        await registry.models("openrouter");
        const selection = { provider: "openrouter" as const, model: "known" };
        expect(registry.configFor(selection)).toMatchObject({ contextWindow: 64000, maxOutputTokens: 2000 });
        registry.rememberSelection(selection);
        const restored = new ProviderRegistry({ settings, env: {}, fetcher: async () => { throw new Error("Unexpected cloud call"); } });
        expect(restored.configFor(selection)).toMatchObject({ contextWindow: 64000, maxOutputTokens: 2000 });
        expect(restored.configFor({ provider: "ollama", model: "known" }).contextWindow).toBeUndefined();
    });
});
