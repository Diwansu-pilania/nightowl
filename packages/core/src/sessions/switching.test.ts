import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SessionController } from "./controller";
import { SessionStore } from "../storage/session-store";
import { mockModel, temporaryDatabase, until } from "../test/fixtures";
import type { AppConfig } from "../config";
import { ProviderRegistry } from "../providers/registry";
import { createModel } from "../ai/model";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const local: AppConfig = { provider: "ollama", model: "local-model", baseURL: "http://localhost:11434/v1" };
const cloud: AppConfig = { provider: "openrouter", model: "cloud-model", baseURL: "https://openrouter.ai/api/v1", apiKey: "test-secret" };
function setup(slow = false) {
    const temp = temporaryDatabase(); cleanups.push(temp.cleanup);
    const models = { ollama: mockModel(slow ? Array.from({ length: 30 }, () => "partial ") : ["local reply"], slow ? 10 : null), openrouter: mockModel(["cloud reply"]) };
    const store = new SessionStore(temp.path);
    const controller = new SessionController({ store, workspace: "test", config: local, modelFactory: (c) => models[c.provider] });
    cleanups.push(controller.dispose);
    return { controller, store, models, path: temp.path };
}

describe("same-session model switching", () => {
    test("preserves history and attribution in both directions, then restores selection", async () => {
        const { controller, store, models, path } = setup();
        const id = controller.getSnapshot().session.id;
        controller.send("Remember Sparrow"); await until(() => controller.getSnapshot().status === "idle");
        controller.switchModel(cloud);
        expect(models.openrouter.doStreamCalls).toHaveLength(0);
        controller.send("What did I say?"); await until(() => controller.getSnapshot().status === "idle");
        expect(JSON.stringify(models.openrouter.doStreamCalls[0]?.prompt)).toContain("Remember Sparrow");
        expect(store.messages(id).filter((m) => m.role === "assistant").map((m) => m.provider)).toEqual(["ollama", "openrouter"]);
        controller.switchModel(local);
        controller.send("Continue"); await until(() => controller.getSnapshot().status === "idle");
        expect(JSON.stringify(models.ollama.doStreamCalls[1]?.prompt)).toContain("cloud reply");
        controller.switchModel(cloud);
        expect(controller.getSnapshot().session.id).toBe(id);
        expect(store.switches(id)).toHaveLength(3);
        expect(JSON.stringify(store.switches(id))).not.toContain("test-secret");
        controller.dispose();
        const reopened = new SessionController({ store: new SessionStore(path), workspace: "test", config: local,
            resolveConfig: (s) => s.provider === "openrouter" ? cloud : local, modelFactory: (c) => models[c.provider] });
        cleanups.push(reopened.dispose);
        expect(reopened.config.provider).toBe("openrouter");
        expect(reopened.getSnapshot().messages).toHaveLength(6);
    });

    test("requires stop consent for an active reply and prevents late chunks after switching", async () => {
        const { controller, models, store } = setup(true);
        controller.send("long answer");
        await until(() => (controller.getSnapshot().messages[1]?.content.length ?? 0) > 0);
        expect(() => controller.switchModel(cloud)).toThrow("Stop it");
        expect(controller.config.provider).toBe("ollama");
        const text = controller.getSnapshot().messages[1]?.content;
        controller.switchModel(cloud, { stopActive: true });
        controller.send("continue here"); await until(() => controller.getSnapshot().status === "idle");
        await Bun.sleep(30);
        expect(controller.getSnapshot().messages[1]).toMatchObject({ content: text, status: "interrupted", provider: "ollama" });
        expect(store.attempts(controller.getSnapshot().session.id)[0]?.status).toBe("interrupted");
        expect(JSON.stringify(models.openrouter.doStreamCalls[0]?.prompt)).toContain("interrupted before it finished");
    });

    test("rejects stale session changes and leaves selection intact if persistence fails", () => {
        const { controller, store } = setup();
        expect(() => controller.switchModel(cloud, { sessionId: "wrong-id" })).toThrow("conversation changed");
        const failure = spyOn(store, "setSelection").mockImplementation(() => { throw new Error("disk full"); });
        expect(() => controller.switchModel(cloud)).toThrow("disk full");
        expect(controller.config.provider).toBe("ollama");
        expect(controller.getSnapshot().storageError).toContain("disk full");
        failure.mockRestore();
    });

    test("exercises both compatible adapters over HTTP without leaking cloud credentials to Ollama", async () => {
        const requests: { path: string; key: string | null; body: any }[] = [];
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path.endsWith("/key")) return Response.json({ data: {} });
            if (path.endsWith("/show")) return Response.json({ capabilities: ["completion"] });
            const body = await request.json();
            requests.push({ path, key: request.headers.get("Authorization"), body });
            const base = { id: "reply", object: "chat.completion.chunk", created: 0, model: "test" };
            const chunks = [
                { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "HTTP reply" }, finish_reason: null }] },
                { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            ];
            return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
        } });
        cleanups.push(() => server.stop(true));
        const origin = `http://127.0.0.1:${server.port}`;
        const fetcher: typeof fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input).replace("https://openrouter.ai/api/v1", `${origin}/cloud`);
            return fetch(url, init);
        }, { preconnect: fetch.preconnect });
        const registry = new ProviderRegistry({ env: { OPENROUTER_API_KEY: "synthetic-key", OLLAMA_BASE_URL: origin }, fetcher });
        const temp = temporaryDatabase(); cleanups.push(temp.cleanup);
        const controller = new SessionController({ store: new SessionStore(temp.path), workspace: "test", config: registry.configFor({ provider: "openrouter", model: "cloud" }),
            resolveConfig: registry.configFor, modelFactory: (config) => createModel(config, fetcher) });
        cleanups.push(controller.dispose);
        controller.send("Remember the constraint: use TypeScript"); await until(() => controller.getSnapshot().status === "idle");
        controller.switchModel(await registry.validate({ provider: "ollama", model: "local" }));
        controller.send("Continue my task"); await until(() => controller.getSnapshot().status === "idle");
        expect(requests).toHaveLength(2);
        expect(requests[0]?.key).toBe("Bearer synthetic-key");
        expect(requests[1]?.key).toBeNull();
        expect(JSON.stringify(requests[1]?.body.messages)).toContain("Remember the constraint: use TypeScript");
        expect(controller.getSnapshot().messages[3]?.status).toBe("completed");
    });
});
