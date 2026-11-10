import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { LanguageModel } from "ai";
import { act } from "react";
import { Root } from "./app";
import type { AppConfig } from "./lib/config";
import { createMockModel } from "./test/mock-model";
import { ProviderRegistry, SessionController, SessionStore } from "@nightowl/core";
import { selectionKey } from "@nightowl/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * End-to-end UI tests: render the real app into a virtual 100x30 terminal,
 * drive it with simulated key presses, and assert on the characters drawn.
 * The model is a mock, so no network or API key is needed.
 */

const config: AppConfig = { provider: "ollama", model: "mock-model", baseURL: "http://localhost:0/v1" };

let destroy: (() => void) | null = null;
afterEach(async () => {
    await act(async () => {
        destroy?.();
        await Bun.sleep(10);
    });
    destroy = null;
});

describe("context and task memory", () => {
    test("/memory saves notes without sending a chat request, and Esc cancels edits", async () => {
        const model = createMockModel(["notes received"]);
        const app = await renderApp({ model });
        await app.type("/memory"); await app.press("enter");
        await app.waitForScreen((frame) => frame.includes("Task memory"));
        await app.type("Project Sparrow. Never use cloud sync.");
        await act(async () => { app.mockInput.pressKey("s", { ctrl: true }); await Bun.sleep(20); });
        await app.waitForScreen((frame) => frame.includes("Task notes saved"));
        expect(app.controller.getSnapshot().contextState.notes).toBe("Project Sparrow. Never use cloud sync.");
        expect(model.doStreamCalls).toHaveLength(0);
        await app.type("/memory"); await app.press("enter");
        await app.waitForScreen((frame) => frame.includes("Never use cloud sync"));
        await app.type("UNSAVED CHANGE"); await app.press("escape");
        await app.waitForScreen((frame) => !frame.includes("Task memory"));
        expect(app.controller.getSnapshot().contextState.notes).not.toContain("UNSAVED");
        await app.type("Continue"); await app.press("enter");
        await app.waitForScreen((frame) => frame.includes("notes received"));
        expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("Never use cloud sync");
    });

    test("/context changes window and reply limits for the selected model", async () => {
        const model = createMockModel(["bounded answer"]);
        const app = await renderApp({ model });
        await app.type("/context"); await app.press("enter");
        await app.waitForScreen((frame) => frame.includes("Context inspector"));
        await app.type("b");
        await app.waitForScreen((frame) => frame.includes("Total context window"));
        await act(async () => {
            app.mockInput.pressKey("END");
            await app.mockInput.pressKeys(["BACKSPACE", "BACKSPACE", "BACKSPACE", "BACKSPACE"]);
            await Bun.sleep(10);
        });
        await app.type("2048"); await app.press("enter");
        await app.waitForScreen((frame) => frame.includes("Maximum reply tokens"));
        await app.press("enter");
        await app.waitForScreen((frame) => frame.includes("Window 2,048"));
        expect(app.controller.getSnapshot().contextState.overrides[selectionKey(config)]).toEqual({ contextWindow: 2048, maxOutputTokens: 512 });
        await app.press("escape");
        await app.waitForScreen((frame) => !frame.includes("Context inspector"));
        await app.type("Use the limits"); await app.press("enter");
        await app.waitForScreen((frame) => frame.includes("bounded answer"));
        expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(512);
    });

    test("/compact shows source evidence and preserves the transcript without an extra request", async () => {
        const model = createMockModel(["Saved answer. ".repeat(35)]);
        const app = await renderApp({ model });
        for (let i = 0; i < 3; i++) {
            await app.type(`Remember requirement ${i}`); await app.press("enter");
            await app.waitForScreen(() => app.controller.getSnapshot().status === "idle");
        }
        await app.type("/compact"); await app.press("enter");
        const frame = await app.waitForScreen((f) => f.includes("Context inspector") && f.includes("older sources: 2"));
        expect(frame).toContain("conservative UTF-8");
        expect(model.doStreamCalls).toHaveLength(3);
        expect(app.controller.getSnapshot().messages).toHaveLength(6);
        expect(app.controller.getSnapshot().lastContext?.summary).toContain("Remember requirement 0");
        await app.type("r");
        await app.waitForScreen(() => !app.controller.getSnapshot().contextState.forceCompact);
    });

    test("oversized messages stay in the editor with an actionable error", async () => {
        const model = createMockModel(["should not run"]);
        const app = await renderApp({ model });
        await act(async () => { await app.mockInput.pasteBracketedText("Keep this input " + "x".repeat(5000)); await Bun.sleep(20); });
        await app.press("enter");
        await app.waitForScreen((frame) => frame.replace(/\s+/g, " ").includes("Nothing was sent"));
        expect(model.doStreamCalls).toHaveLength(0);
        expect(app.controller.getSnapshot().messages).toHaveLength(0);
        await act(async () => { app.controller.setContextLimits({ contextWindow: 16000, maxOutputTokens: 2048 }); });
        await app.press("enter");
        await app.waitForScreen((frame) => frame.includes("should not run"));
        expect(app.controller.getSnapshot().messages[0]?.content).toStartWith("Keep this input");
    });

    test("long replies leave the input visible and can be previewed and compacted", async () => {
        const app = await renderApp({ model: createMockModel(["Long completed reply. ".repeat(300)]) });
        await app.type("Give a long answer"); await app.press("enter");
        await app.waitForScreen(() => app.controller.getSnapshot().status === "idle");
        const frame = app.captureCharFrame();
        expect(frame).toContain("Ask anything");
        expect(frame).toContain("Chat");
        await app.type("/compact"); await app.press("enter");
        const preview = await app.waitForScreen((screen) => screen.includes("Context inspector"));
        expect(preview).not.toContain("Nothing was sent");
        expect(app.controller.getSnapshot().lastContext?.compacted).toBe(true);
    });
});

async function renderApp(options: { model?: LanguageModel; configProblem?: string; controller?: SessionController; providers?: ProviderRegistry; initialSetup?: boolean } = {}) {
    const controller = options.controller ?? new SessionController({
        store: new SessionStore(":memory:"), workspace: "test-workspace", config,
        model: options.model ?? createMockModel(["ok"]), configProblem: options.configProblem,
    });
    const setup = await testRender(
        <Root controller={controller} providers={options.providers} initialSetup={options.initialSetup} />,
        { width: 100, height: 30 },
    );
    destroy = () => { setup.renderer.destroy(); controller.dispose(); };
    await setup.renderOnce();

    // The test renderer has no render loop: it only draws when we call
    // renderOnce(). `act()` tells React to apply pending state updates first.
    // OpenTUI parses key presses asynchronously, so we keep act() open a few
    // milliseconds after sending them; otherwise the resulting React updates
    // land outside act() and React prints warnings.
    const type = async (text: string) => {
        await act(async () => {
            await setup.mockInput.typeText(text);
            await Bun.sleep(10);
        });
    };
    const press = async (key: "enter" | "escape") => {
        await act(async () => {
            if (key === "enter") setup.mockInput.pressEnter();
            else setup.mockInput.pressEscape();
            await Bun.sleep(10);
        });
    };

    /** Keeps letting time pass and re-rendering until the screen matches. */
    const waitForScreen = async (predicate: (frame: string) => boolean, timeoutMs = 3000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            await act(() => Bun.sleep(10));
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            if (predicate(frame)) return frame;
            if (Date.now() > deadline) {
                throw new Error(`Timed out waiting for the screen. Last frame:\n${frame}`);
            }
        }
    };

    return { ...setup, controller, type, press, waitForScreen };
}

describe("chat", () => {
    test("exports and imports through dialogs, preserving notes and context for the next reply", async () => {
        const prefix = join(tmpdir(), "nightowl-ui-export-");
        const directory = mkdtempSync(prefix);
        try {
            const file = join(directory, "portable chat.nightowl.json");
            const model = createMockModel(["Saved Sparrow reply"]);
            const app = await renderApp({ model });
            await act(async () => { app.controller.setNotes("Keep SQLite"); });
            await app.type("Remember Sparrow"); await app.press("enter");
            await app.waitForScreen(() => app.controller.getSnapshot().status === "idle");
            const original = app.controller.getSnapshot().session.id;
            await app.type("/export"); await app.press("enter");
            await app.waitForScreen((f) => f.includes("Export conversation"));
            const defaultName = `nightowl-${original.slice(0, 8)}.nightowl.json`;
            await act(async () => { app.mockInput.pressKey("END"); await app.mockInput.pressKeys(Array(defaultName.length).fill("BACKSPACE")); await Bun.sleep(10); });
            await app.type(file); await app.press("enter");
            await app.waitForScreen((f) => !f.includes("Export conversation"));
            expect(JSON.parse(readFileSync(file, "utf8")).notes).toBe("Keep SQLite");
            await app.type("/import"); await app.press("enter");
            await app.waitForScreen((f) => f.includes("Import conversation"));
            await app.type(file); await app.press("enter");
            await app.waitForScreen(() => app.controller.getSnapshot().session.id !== original);
            expect(app.controller.getSnapshot().messages).toHaveLength(2);
            expect(app.controller.getSnapshot().contextState.notes).toBe("Keep SQLite");
            expect(app.controller.config).toEqual(config);
            expect(model.doStreamCalls).toHaveLength(1);
            await app.type("Continue"); await app.press("enter");
            await app.waitForScreen(() => app.controller.getSnapshot().status === "idle");
            expect(model.doStreamCalls).toHaveLength(2);
            expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("Remember Sparrow");
            expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("Keep SQLite");
        } finally {
            const target = resolve(directory);
            if (!target.startsWith(resolve(prefix)) || target === resolve(tmpdir())) throw new Error("Unsafe test cleanup path");
            rmSync(target, { recursive: true, force: true });
        }
    });

    test("renders basic Markdown and code without changing the saved answer", async () => {
        const content = "## Implementation\n\nUse **TypeScript** and `SQLite`.\n\n- Keep context\n- Save sessions\n\n```ts\nconst answer = 42;\n```";
        const app = await renderApp({ model: createMockModel([content]) });
        await app.type("Explain"); await app.press("enter");
        const frame = await app.waitForScreen((f) => f.includes("const answer = 42;"));
        expect(frame).toContain("Implementation");
        expect(frame).not.toContain("## Implementation");
        expect(frame).not.toContain("**TypeScript**");
        expect(app.controller.getSnapshot().messages[1]?.content).toBe(content);
    });

    test("renames a session through its dialog without sending a model request", async () => {
        const model = createMockModel(["ok"]);
        const app = await renderApp({ model });
        await app.type("/rename"); await app.press("enter");
        await app.waitForScreen((f) => f.includes("Rename conversation"));
        await act(async () => { app.mockInput.pressKey("END"); await app.mockInput.pressKeys(Array(16).fill("BACKSPACE")); await Bun.sleep(10); });
        await app.type("Sparrow plan"); await app.press("enter");
        await app.waitForScreen((f) => f.includes("Conversation renamed"));
        expect(app.controller.getSnapshot().session.title).toBe("Sparrow plan");
        expect(model.doStreamCalls).toHaveLength(0);
        await app.type("First message"); await app.press("enter");
        await app.waitForScreen(() => app.controller.getSnapshot().status === "idle");
        expect(app.controller.getSnapshot().session.title).toBe("Sparrow plan");
    });
    test("uses wide terminals and reflows on resize without losing the draft", async () => {
        const reply = "This answer uses the available terminal width instead of wrapping inside a narrow centered column with large empty margins.";
        const app = await renderApp({ model: createMockModel([reply]) });
        await act(async () => { app.resize(180, 32); await Bun.sleep(10); });
        await app.type("Show a wide reply"); await app.press("enter");
        const wide = await app.waitForScreen((frame) => frame.includes(reply));
        const input = wide.split("\n").find((line) => line.includes("Ask anything"))!;
        expect(input.indexOf("│")).toBeLessThan(6);
        expect(input.lastIndexOf("│")).toBeGreaterThan(170);
        await app.type("Draft survives resizing");
        await act(async () => { app.resize(80, 24); await Bun.sleep(10); });
        const narrow = await app.waitForScreen((frame) => frame.includes("Draft survives resizing"));
        expect(narrow).toContain("mock-model");
        expect(app.controller.getSnapshot().messages[1]?.content).toBe(reply);
    });

    test("starts on the home screen with the model in the status bar", async () => {
        const { captureCharFrame } = await renderApp();
        const frame = captureCharFrame();

        expect(frame).toContain("Ask anything");
        expect(frame).toContain("mock-model");
    });

    test("sends a message and streams the reply", async () => {
        const app = await renderApp({ model: createMockModel(["Hello ", "from ", "NightOwl!"]) });

        await app.type("hi there");
        await app.press("enter");

        const frame = await app.waitForScreen((f) => f.includes("Hello from NightOwl!"));
        expect(frame).toContain("hi there"); // the user's own message is shown too
    });

    test("Esc stops a reply that is still streaming", async () => {
        const chunks = Array.from({ length: 40 }, (_, i) => `w${i} `);
        const app = await renderApp({ model: createMockModel(chunks, { chunkDelayInMs: 30 }) });

        await app.type("write a lot");
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("w1 "));

        await app.press("escape");

        const frame = await app.waitForScreen((f) => f.includes("(stopped)"));
        expect(frame).not.toContain("w39");
    });

    test("/new clears the conversation", async () => {
        const app = await renderApp({ model: createMockModel(["first reply"]) });

        await app.type("hello");
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("first reply"));

        await app.type("/new");
        await app.press("enter");

        const frame = await app.waitForScreen((f) => f.includes("Started a new conversation"));
        expect(frame).not.toContain("first reply");
        expect(frame).toContain("Ask anything");
    });

    test("shows a config problem instead of calling the model", async () => {
        const model = createMockModel(["should not be used"]);
        const app = await renderApp({
            model,
            configProblem: "OPENROUTER_API_KEY is not set. Add it to your .env file.",
        });

        await app.type("hi");
        await app.press("enter");

        await app.waitForScreen((f) => f.includes("OPENROUTER_API_KEY is not set"));
        expect(model.doStreamCalls).toHaveLength(0);
    });

    test("/sessions restores the conversation kept by /new", async () => {
        const app = await renderApp({ model: createMockModel(["Remember the old task"]) });
        await app.type("first project task");
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("Remember the old task"));
        const originalId = app.controller.getSnapshot().session.id;
        await app.type("/new");
        await app.press("enter");
        await app.type("/sessions");
        await app.press("enter");
        const menu = await app.waitForScreen((f) => f.includes("Saved conversations"));
        expect(menu).toContain("first project task");
        await act(async () => { app.mockInput.pressArrow("down"); await Bun.sleep(10); });
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("Remember the old task") && !f.includes("Saved conversations"));
        expect(app.controller.getSnapshot().session.id).toBe(originalId);
    });

    test("a command submitted before the menu renders never goes to the model", async () => {
        const model = createMockModel(["this should never run"]);
        const app = await renderApp({ model });
        const originalId = app.controller.getSnapshot().session.id;
        await act(async () => {
            await app.mockInput.typeText("/new");
            app.mockInput.pressEnter();
            await Bun.sleep(10);
        });
        await app.waitForScreen((f) => f.includes("Started a new conversation"));
        expect(app.controller.getSnapshot().session.id).not.toBe(originalId);
        expect(model.doStreamCalls).toHaveLength(0);
    });

    test("/models searches local models and continues the same conversation", async () => {
        const first = createMockModel(["Original reply"]);
        const second = createMockModel(["Reply from the new model"]);
        const providers = new ProviderRegistry({ env: {}, fetcher: async (url) => Response.json(
            url.endsWith("/tags") ? { models: [{ name: "local-one" }, { name: "local-two" }] } : { capabilities: ["completion"] },
        ) });
        const controller = new SessionController({ store: new SessionStore(":memory:"), workspace: "test", config,
            resolveConfig: providers.configFor, modelFactory: (c) => c.model === "local-two" ? second : first });
        const app = await renderApp({ controller, providers });
        await app.type("Keep the GraphQL requirement"); await app.press("enter");
        await app.waitForScreen((f) => f.includes("Original reply"));
        const sessionId = controller.getSnapshot().session.id;
        await app.type("/models"); await app.press("enter");
        await app.waitForScreen((f) => f.includes("Models & providers"));
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("local-two"));
        await app.type("local-two"); await app.press("enter");
        await app.waitForScreen((f) => !f.includes("Models & providers") && f.includes("local-two"));
        expect(controller.config.model).toBe("local-two");
        expect(controller.getSnapshot().session.id).toBe(sessionId);
        await app.type("Continue the task"); await app.press("enter");
        await app.waitForScreen((f) => f.includes("Reply from the new model"));
        expect(JSON.stringify(second.doStreamCalls[0]?.prompt)).toContain("Keep the GraphQL requirement");
    });

    test("setup masks API keys and keeps them out of chat history", async () => {
        const model = createMockModel(["not requested"]);
        const providers = new ProviderRegistry({ env: {}, fetcher: async (url) => Response.json(
            url.endsWith("/models") ? { data: [{ id: "vendor/chat-model", name: "Chat" }] } : { data: {} },
        ) });
        const app = await renderApp({ model, providers, initialSetup: true });
        await act(async () => { app.mockInput.pressArrow("down"); await Bun.sleep(10); });
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("API key (hidden)"));
        await app.type("synthetic-ui-key");
        const secretFrame = await app.waitForScreen((f) => f.includes("characters"));
        expect(secretFrame).not.toContain("synthetic-ui-key");
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("vendor/chat-model"));
        await app.press("enter");
        await app.waitForScreen((f) => !f.includes("Models & providers") && f.includes("vendor/chat-model"));
        expect(app.controller.config.provider).toBe("openrouter");
        expect(app.controller.getSnapshot().messages).toHaveLength(0);
        expect(providers.settings.readKey()).toBeUndefined();
        expect(model.doStreamCalls).toHaveLength(0);
    });

    test("the picker handles Esc and asks before stopping an active response", async () => {
        const providers = new ProviderRegistry({ env: {}, fetcher: async (url) => Response.json(
            url.endsWith("/tags") ? { models: [{ name: "replacement" }] } : {},
        ) });
        const app = await renderApp({ providers, model: createMockModel(Array.from({ length: 200 }, () => "stream "), { chunkDelayInMs: 20 }) });
        await app.type("write a long response"); await app.press("enter");
        await app.waitForScreen((f) => f.includes("stream "));
        await app.type("/models"); await app.press("enter");
        await app.waitForScreen((f) => f.includes("Models & providers"));
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("replacement"));
        await app.press("escape");
        // Wait for the standalone Escape to be parsed before sending Enter;
        // adjacent ESC + Enter bytes otherwise represent Alt+Enter in a terminal.
        await app.waitForScreen((f) => f.includes("Choose where to run"));
        expect(app.controller.getSnapshot().status).toBe("streaming");
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("replacement"));
        await app.press("enter");
        await app.waitForScreen((f) => f.includes("Stop the current reply"));
        expect(app.controller.config.model).toBe("mock-model");
        await app.press("enter");
        await app.waitForScreen((f) => !f.includes("Models & providers") && f.includes("(stopped)"));
        expect(app.controller.config.model).toBe("replacement");
        expect(app.controller.getSnapshot().status).toBe("idle");
        expect(app.controller.getSnapshot().messages).toHaveLength(2);
    });
});
