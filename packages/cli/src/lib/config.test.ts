import { describe, expect, test } from "bun:test";
import { getConfigProblem, loadConfig } from "./config";

describe("loadConfig", () => {
    test("falls back to local Ollama when nothing is configured", () => {
        const config = loadConfig({});
        expect(config.provider).toBe("ollama");
        expect(config.baseURL).toBe("http://localhost:11434/v1");
        expect(config.apiKey).toBeUndefined();
    });

    test("picks OpenRouter automatically when a key is present", () => {
        const config = loadConfig({ OPENROUTER_API_KEY: "sk-test" });
        expect(config.provider).toBe("openrouter");
        expect(config.apiKey).toBe("sk-test");
        expect(config.model).toBe("anthropic/claude-sonnet-5.5");
    });

    test("NIGHTOWL_PROVIDER overrides auto-detection", () => {
        const config = loadConfig({ OPENROUTER_API_KEY: "sk-test", NIGHTOWL_PROVIDER: "Ollama" });
        expect(config.provider).toBe("ollama");
        // The OpenRouter key must never be sent to a different provider.
        expect(config.apiKey).toBeUndefined();
    });

    test("respects NIGHTOWL_MODEL and OLLAMA_BASE_URL", () => {
        const config = loadConfig({ NIGHTOWL_MODEL: "qwen3", OLLAMA_BASE_URL: "http://gpu-box:11434/v1" });
        expect(config.model).toBe("qwen3");
        expect(config.baseURL).toBe("http://gpu-box:11434/v1");
    });
});

describe("getConfigProblem", () => {
    test("reports a missing OpenRouter key", () => {
        const env = { NIGHTOWL_PROVIDER: "openrouter" };
        expect(getConfigProblem(loadConfig(env), env)).toContain("OPENROUTER_API_KEY");
    });

    test("reports an unknown provider name", () => {
        const env = { NIGHTOWL_PROVIDER: "gpt" };
        expect(getConfigProblem(loadConfig(env), env)).toContain('Unknown NIGHTOWL_PROVIDER "gpt"');
    });

    test("is happy with a working setup", () => {
        expect(getConfigProblem(loadConfig({}), {})).toBeNull();
    });
});
