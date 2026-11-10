import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionStore } from "./session-store";
import { temporaryDatabase } from "../test/fixtures";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const selection = { provider: "ollama" as const, model: "test-model" };

function database() {
    const temp = temporaryDatabase();
    cleanups.push(temp.cleanup);
    return temp.path;
}
function open(path: string) {
    const store = new SessionStore(path);
    cleanups.push(() => store.close());
    return store;
}

describe("durable session store", () => {
    test("persists ordered messages, provider attribution and attempts across reopen", () => {
        const path = database();
        const store = open(path);
        const session = store.create("workspace");
        const turn = store.startTurn(session.id, "Use TypeScript", selection);
        store.saveReply(session.id, turn.assistant.id, "I will use TypeScript", "completed");
        store.close();
        const reopened = open(path);
        reopened.acquire(session.id, "workspace");
        expect(reopened.list("workspace")[0]?.title).toBe("Use TypeScript");
        expect(reopened.messages(session.id).map((m) => m.content)).toEqual(["Use TypeScript", "I will use TypeScript"]);
        expect(reopened.messages(session.id)[1]?.provider).toBe("ollama");
        expect(reopened.attempts(session.id)[0]).toMatchObject({ status: "completed", model: "test-model", messageId: turn.assistant.id });
    });

    test("recovers checkpointed unfinished replies without erasing partial text", () => {
        const path = database();
        const store = open(path);
        const session = store.create("workspace");
        const turn = store.startTurn(session.id, "continue", selection);
        store.saveReply(session.id, turn.assistant.id, "partial output", "streaming");
        store.close();
        const reopened = open(path);
        reopened.acquire(session.id, "workspace");
        expect(reopened.messages(session.id)[1]).toMatchObject({ content: "partial output", status: "interrupted", interrupted: true });
        expect(reopened.attempts(session.id)[0]?.status).toBe("interrupted");
    });

    test("another live writer cannot acquire or recover an active session", () => {
        const path = database();
        const first = open(path);
        const session = first.create("workspace");
        first.startTurn(session.id, "hello", selection);
        const second = open(path);
        expect(() => second.acquire(session.id, "workspace")).toThrow("another NightOwl process");
        expect(first.messages(session.id)[1]?.status).toBe("streaming");
        expect(() => second.startTurn(session.id, "intruder", selection)).toThrow("no longer owns");
        first.close();
        expect(second.acquire(session.id, "workspace").id).toBe(session.id);
    });

    test("sessions are workspace scoped and finalized replies reject stale writes", () => {
        const store = open(database());
        const session = store.create("first-workspace");
        const turn = store.startTurn(session.id, "hello", selection);
        store.saveReply(session.id, turn.assistant.id, "done", "completed");
        expect(() => store.saveReply(session.id, turn.assistant.id, "late chunk", "streaming")).toThrow("no longer running");
        expect(store.messages(session.id)[1]?.content).toBe("done");
        expect(store.list("second-workspace")).toEqual([]);
        expect(() => store.acquire(session.id, "second-workspace")).toThrow("not found");
    });

    test("failed turn creation is atomic", () => {
        const path = database();
        const store = open(path);
        const session = store.create("workspace");
        const db = new Database(path);
        db.exec("CREATE TRIGGER fail_attempt BEFORE INSERT ON attempts BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;");
        db.close();
        expect(() => store.startTurn(session.id, "must not be half saved", selection)).toThrow("simulated storage failure");
        expect(store.messages(session.id)).toEqual([]);
        expect(store.attempts(session.id)).toEqual([]);
    });

    test("refuses newer schema versions without modifying them", () => {
        const path = database();
        const db = new Database(path);
        db.exec("PRAGMA user_version = 99;");
        db.close();
        expect(() => new SessionStore(path)).toThrow("newer NightOwl");
        const check = new Database(path);
        expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
        check.close();
    });

    test("recovers the lock and partial reply after a process exits without cleanup", async () => {
        const path = database();
        // Spawn Bun without a shell and exit before store.close() can release ownership.
        const child = Bun.spawn([process.execPath, "-e", `
            import { SessionStore } from ${JSON.stringify(new URL("./session-store.ts", import.meta.url).href)};
            const store = new SessionStore(process.env.NIGHTOWL_TEST_DB);
            const session = store.create("workspace");
            const turn = store.startTurn(session.id, "crash recovery task", { provider: "ollama", model: "test" });
            store.saveReply(session.id, turn.assistant.id, "checkpoint before exit", "streaming");
            process.exit(0);
        `], { env: { ...process.env, NIGHTOWL_TEST_DB: path }, stdout: "pipe", stderr: "pipe" });
        expect(await child.exited).toBe(0);
        const reopened = open(path);
        const session = reopened.list("workspace")[0]!;
        reopened.acquire(session.id, "workspace");
        expect(reopened.messages(session.id)[1]).toMatchObject({ content: "checkpoint before exit", status: "interrupted" });
        expect(reopened.attempts(session.id)[0]?.status).toBe("interrupted");
    });
});
