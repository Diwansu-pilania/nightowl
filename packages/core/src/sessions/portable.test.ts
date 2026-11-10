import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionStore } from "../storage/session-store";
import { parseSessionExport, readSessionExport, writeSessionExport } from "./portable";
import { temporaryDatabase } from "../test/fixtures";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function setup() {
    const temp = temporaryDatabase(); cleanup.push(temp.cleanup);
    const store = new SessionStore(temp.path); cleanup.push(() => store.close());
    const selection = { provider: "ollama" as const, model: "local" };
    const session = store.create("original-workspace", selection);
    const turn = store.startTurn(session.id, "Remember Sparrow", selection);
    store.saveReply(session.id, turn.assistant.id, "Partial work", "interrupted");
    store.saveContextState(session.id, { notes: "Keep SQLite", forceCompact: true, overrides: {} });
    return { store, session, path: temp.path };
}

test("portable sessions round-trip text, notes, and attribution into fresh IDs and workspace", () => {
    const { store, session, path } = setup();
    store.rename(session.id, "Portable Sparrow");
    const data = store.exportSession(session.id, "original-workspace");
    const file = join(dirname(path), "chat.nightowl.json");
    writeSessionExport(file, data);
    const parsed = readSessionExport(file);
    const copy = store.importSession(parsed, "new-workspace", { provider: "openrouter", model: "chosen" });
    expect(copy.id).not.toBe(session.id);
    expect(copy.title).toBe("Portable Sparrow");
    expect(copy.selection).toEqual({ provider: "openrouter", model: "chosen" });
    expect(store.messages(copy.id)[0]?.id).not.toBe(data.messages[0]?.id);
    expect(store.messages(copy.id).map((m) => m.content)).toEqual(["Remember Sparrow", "Partial work"]);
    expect(store.messages(copy.id)[1]).toMatchObject({ provider: "ollama", model: "local", interrupted: true });
    expect(store.contextState(copy.id)).toEqual({ notes: "Keep SQLite", forceCompact: false, overrides: {} });
    expect(store.attempts(copy.id)).toHaveLength(0);
    expect(JSON.stringify(data)).not.toContain("original-workspace");
    expect(() => writeSessionExport(file, data)).toThrow();
    expect(readFileSync(file, "utf8")).toContain("Sparrow");
});

test("rejects settings, tool payloads, bad references, unsupported versions, and oversized files", () => {
    const { store, session, path } = setup();
    const valid = store.exportSession(session.id, "original-workspace");
    for (const value of [
        { ...valid, apiKey: "must-never-import" }, { ...valid, version: 9 },
        { ...valid, messages: [{ ...valid.messages[0], role: "tool" }] },
        { ...valid, messages: [valid.messages[1], valid.messages[0]] },
        { ...valid, messages: [valid.messages[0], valid.messages[0]] },
        { ...valid, messages: [valid.messages[0], { ...valid.messages[1], status: ["completed"] }] },
        { ...valid, messages: [{ ...valid.messages[0], content: "x".repeat(1_000_001) }] },
    ]) expect(() => parseSessionExport(JSON.stringify(value))).toThrow();
    const file = join(dirname(path), "huge.json");
    writeFileSync(file, " ".repeat(10 * 1024 * 1024 + 1));
    expect(() => readSessionExport(file)).toThrow("10 MiB");
    expect(store.list("original-workspace")).toHaveLength(1);
});

test("imports are atomic on a storage failure and streaming exports stay incomplete", () => {
    const { store, session, path } = setup();
    const turn = store.startTurn(session.id, "Pending", { provider: "ollama", model: "local" });
    const data = store.exportSession(session.id, "original-workspace");
    expect(data.messages.at(-1)?.status).toBe("interrupted");
    const db = new Database(path);
    db.exec("CREATE TRIGGER refuse_import BEFORE INSERT ON context_state BEGIN SELECT RAISE(ABORT,'disk full'); END;");
    db.close();
    expect(() => store.importSession(data, "target")).toThrow("disk full");
    expect(store.list("target")).toHaveLength(0);
    expect(store.messages(session.id).at(-1)?.id).toBe(turn.assistant.id);
});
