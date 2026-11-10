export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function ollamaURLs(value: string): { baseURL: string; apiURL: string } {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Ollama needs a complete http:// or https:// server URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("Use an HTTP(S) Ollama URL without embedded credentials, query parameters, or fragments.");
    }
    const root = url.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
    return { baseURL: `${root}/v1`, apiURL: `${root}/api` };
}

export function checkModelId(value: string): string {
    const id = value.trim();
    if (!id || id.length > 256 || /\s|[\x00-\x1f\x7f]/.test(id)) throw new Error("Enter a model ID without spaces (up to 256 characters).");
    return id;
}

export function checkApiKey(value: string): string {
    const key = value.trim();
    if (!key || key.length > 512 || /[^\x21-\x7e]/.test(key)) throw new Error("Enter a non-empty API key without spaces or control characters.");
    return key;
}
