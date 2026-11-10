import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionController } from "./controller";
import { SessionStore } from "../storage/session-store";
import { temporaryDatabase, mockModel, until } from "../test/fixtures";
import { selectionKey } from "../context/builder";
import type { AppConfig } from "../config";

const config: AppConfig = { provider: "ollama", model: "local", baseURL: "http://localhost:0/v1" };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function setup() {
    const temp = temporaryDatabase(); cleanups.push(temp.cleanup);
    const store = new SessionStore(temp.path);
    const model = mockModel(["A saved answer. ".repeat(25)]);
    const controller = new SessionController({ store, workspace: "test", config, model });
    cleanups.push(controller.dispose);
    return { path: temp.path, store, model, controller };
}

test("smaller-model handoff preserves explicit facts and originals, enforces reply limits, and survives restart", async () => {
    const { controller, model, store, path } = setup();
    controller.setNotes("Project Sparrow. TypeScript only. SQLite persistence. Never use cloud sync.");
    controller.setContextLimits({ contextWindow: 16000, maxOutputTokens: 1000 });
    const sessionId = controller.getSnapshot().session.id;
    for (let i = 0; i < 8; i++) {
        expect(controller.send(`Discuss part ${i}. ${"detail ".repeat(90)}`)).toBe(true);
        await until(() => controller.getSnapshot().status === "idle");
    }
    const original = store.messages(sessionId);
    controller.switchModel({ ...config, model: "smaller", contextWindow: 2048 });
    expect(controller.send("Continue the task")).toBe(true);
    await until(() => controller.getSnapshot().status === "idle");
    const request = model.doStreamCalls.at(-1)!;
    const prompt = JSON.stringify(request.prompt);
    for (const fact of ["Sparrow", "TypeScript only", "SQLite persistence", "Never use cloud sync", "Continue the task"]) expect(prompt).toContain(fact);
    expect(request.maxOutputTokens).toBe(512);
    expect(model.doStreamCalls).toHaveLength(9); // compaction never generates extra model requests
    expect(store.messages(sessionId).slice(0, original.length)).toEqual(original);
    expect(controller.getSnapshot().lastContext?.compacted).toBe(true);
    expect(controller.getSnapshot().lastContext?.model).toBe("smaller");
    controller.setContextLimits({ contextWindow: 2048, maxOutputTokens: 256 });
    controller.compact();
    controller.dispose();
    const reopened = new SessionController({ store: new SessionStore(path), workspace: "test", config, model });
    cleanups.push(reopened.dispose);
    expect(reopened.getSnapshot().contextState.notes).toContain("Sparrow");
    expect(reopened.getSnapshot().contextState.forceCompact).toBe(true);
    expect(reopened.getSnapshot().contextState.overrides[selectionKey({ ...config, model: "smaller" })]?.maxOutputTokens).toBe(256);
    expect(reopened.getSnapshot().lastContext?.sourceIds.length).toBeGreaterThan(0);
    reopened.reset();
    expect(reopened.getSnapshot().contextState.notes).toBe("");
    reopened.resume(sessionId);
    expect(reopened.getSnapshot().contextState.notes).toContain("Sparrow");
    reopened.setNotes("");
    expect(reopened.getSnapshot().contextState.notes).toBe("");
});

test("oversized input stays unaccepted, with no model request or saved partial turn", () => {
    const { controller, model, store } = setup();
    expect(controller.send("x".repeat(5000))).toBe(false);
    expect(controller.getSnapshot().contextError).toContain("Nothing was sent");
    expect(store.messages(controller.getSnapshot().session.id)).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(0);
    controller.setContextLimits({ contextWindow: 32000, maxOutputTokens: 2048 });
    expect(controller.getSnapshot().contextError).toBeNull();
});

test("failed context persistence prevents network requests and blocks further sends", async () => {
    const { controller, store, model } = setup();
    const failure = spyOn(store, "saveContextRecord").mockImplementation(() => { throw new Error("disk full"); });
    expect(controller.send("Save before sending")).toBe(true);
    await until(() => controller.getSnapshot().status === "idle");
    expect(model.doStreamCalls).toHaveLength(0);
    expect(controller.getSnapshot().storageError).toContain("disk full");
    expect(controller.getSnapshot().messages[1]?.error).toContain("Nothing was sent");
    expect(controller.send("blocked")).toBe(false);
    failure.mockRestore();
});

test("notes and manual compaction cannot change an active request", () => {
    const { controller } = setup();
    controller.send("hello");
    expect(() => controller.setNotes("new notes")).toThrow("Stop the current reply");
    expect(() => controller.compact()).toThrow("Stop the current reply");
    controller.stop();
    controller.setNotes("safe after stopping");
    expect(controller.getSnapshot().contextState.notes).toBe("safe after stopping");
});

test("manual compaction policy and its record roll back together when storage fails", () => {
    const { controller, store, path } = setup();
    controller.setNotes("Keep this note");
    const db = new Database(path);
    db.exec("CREATE TRIGGER fail_context BEFORE INSERT ON context_runs BEGIN SELECT RAISE(ABORT,'disk full'); END;");
    db.close();
    expect(() => controller.compact()).toThrow("disk full");
    expect(store.contextState(controller.getSnapshot().session.id)).toMatchObject({ notes: "Keep this note", forceCompact: false });
    expect(store.latestContextRecord(controller.getSnapshot().session.id)).toBeNull();
});
