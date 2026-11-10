import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SessionController } from "./controller";
import { SessionStore } from "../storage/session-store";
import { mockModel, temporaryDatabase, until } from "../test/fixtures";
import { toModelMessages } from "../ai/chat";

const config = { provider: "ollama" as const, model: "test-model", baseURL: "http://localhost:0/v1" };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function database() {
    const temp = temporaryDatabase();
    cleanups.push(temp.cleanup);
    return temp.path;
}
function create(path: string, model = mockModel(["saved reply"])) {
    const store = new SessionStore(path);
    const controller = new SessionController({ store, workspace: "workspace", config, model, checkpointMs: 10 });
    cleanups.push(controller.dispose);
    return { store, controller, model };
}

describe("session controller", () => {
    test("commits the user turn immediately and replays earlier history after restart", async () => {
        const path = database();
        const first = create(path);
        expect(first.controller.send("The project is named Sparrow")).toBe(true);
        expect(first.store.messages(first.controller.getSnapshot().session.id)[0]?.content).toBe("The project is named Sparrow");
        await until(() => first.controller.getSnapshot().status === "idle");
        const id = first.controller.getSnapshot().session.id;
        first.controller.dispose();
        const second = create(path);
        expect(second.controller.getSnapshot().session.id).toBe(id);
        expect(second.controller.getSnapshot().messages).toHaveLength(2);
        second.controller.send("What is the project's name?");
        await until(() => second.controller.getSnapshot().status === "idle");
        const prompt = JSON.stringify(second.model.doStreamCalls[0]?.prompt);
        expect(prompt).toContain("The project is named Sparrow");
        expect(prompt).toContain("saved reply");
        expect(prompt).toContain("What is the project's name?");
    });

    test("checkpoints during streaming and flushes visible text synchronously on dispose", async () => {
        const path = database();
        const first = create(path, mockModel(Array.from({ length: 40 }, () => "chunk "), 10));
        first.controller.send("long response");
        const id = first.controller.getSnapshot().session.id;
        await until(() => (first.store.messages(id)[1]?.content.length ?? 0) > 0);
        expect(first.store.messages(id)[1]?.status).toBe("streaming");
        const visible = first.controller.getSnapshot().messages[1]?.content;
        first.controller.dispose();
        const second = create(path);
        expect(second.controller.getSnapshot().messages[1]).toMatchObject({ content: visible, interrupted: true });
        expect(second.model.doStreamCalls).toHaveLength(0);
        expect(JSON.stringify(toModelMessages(second.controller.getSnapshot().messages))).toContain("interrupted before it finished");
    });

    test("/new preserves the old session and late chunks cannot enter the new one", async () => {
        const { controller, store } = create(database(), mockModel(Array.from({ length: 20 }, () => "old "), 10));
        controller.send("old task");
        await until(() => (controller.getSnapshot().messages[1]?.content.length ?? 0) > 0);
        const originalId = controller.getSnapshot().session.id;
        expect(controller.reset()).toBe(true);
        expect(controller.getSnapshot().session.id).not.toBe(originalId);
        await Bun.sleep(60);
        expect(controller.getSnapshot().messages).toEqual([]);
        expect(store.messages(originalId)[1]?.status).toBe("interrupted");
        controller.resume(originalId);
        expect(controller.getSnapshot().messages[0]?.content).toBe("old task");
    });

    test("stopping and immediately sending again leaves the new request active", async () => {
        const { controller } = create(database(), mockModel(["one ", "two ", "three"], 20));
        controller.send("first");
        expect(controller.send("blocked")).toBe(false);
        controller.stop();
        expect(controller.send("second")).toBe(true);
        await Bun.sleep(10);
        expect(controller.getSnapshot().status).toBe("streaming");
        await until(() => controller.getSnapshot().status === "idle");
        expect(controller.getSnapshot().messages).toHaveLength(4);
        expect(controller.getSnapshot().messages[1]?.interrupted).toBe(true);
        expect(controller.getSnapshot().messages[3]?.status).toBe("completed");
    });

    test("storage failure before send preserves input and never calls the model", async () => {
        const { controller, store, model } = create(database());
        const failing = spyOn(store, "startTurn").mockImplementation(() => { throw new Error("disk full"); });
        expect(controller.send("do not lose this")).toBe(false);
        expect(controller.getSnapshot().storageError).toContain("disk full");
        expect(controller.getSnapshot().messages).toEqual([]);
        expect(model.doStreamCalls).toHaveLength(0);
        failing.mockRestore();
    });

    test("failed checkpoints stop the request and keep unsaved text visible", async () => {
        const { controller, store } = create(database(), mockModel(Array.from({ length: 20 }, () => "keep me "), 10));
        const failing = spyOn(store, "saveReply").mockImplementation(() => { throw new Error("disk full"); });
        controller.send("hello");
        await until(() => controller.getSnapshot().storageError !== null);
        expect(controller.getSnapshot().messages[1]?.content).toContain("keep me");
        expect(controller.getSnapshot().messages[1]?.status).toBe("interrupted");
        expect(controller.send("blocked until storage fixed")).toBe(false);
        expect(controller.reset()).toBe(false);
        failing.mockRestore();
    });
});
