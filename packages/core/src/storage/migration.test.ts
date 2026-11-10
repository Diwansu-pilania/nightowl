import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionStore } from "./session-store";
import { temporaryDatabase } from "../test/fixtures";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

function legacyDatabase(liveOwner = false) {
    const temp = temporaryDatabase(); cleanups.push(temp.cleanup);
    const db = new Database(temp.path);
    cleanups.push(() => db.close());
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, opened_at INTEGER NOT NULL, owner TEXT, owner_pid INTEGER);
        CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL,
            role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, provider TEXT, model TEXT, error TEXT);
        CREATE TABLE attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
            provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT);
        PRAGMA user_version = 1;
    `);
    db.query("INSERT INTO sessions VALUES ('old-session','workspace','Existing task',1,1,1,?,?)").run(liveOwner ? "old-process" : null, liveOwner ? process.pid : null);
    db.exec(`
        INSERT INTO messages VALUES ('old-message','old-session','old-turn','assistant','Keep this history','completed',1,'ollama','legacy-model',NULL);
        INSERT INTO attempts VALUES ('old-attempt','old-session','old-message','ollama','legacy-model','completed',1,2,NULL);
    `);
    return { path: temp.path, db };
}

test("upgrades v1 with a consistent backup including WAL data and preserves history", () => {
    const { path } = legacyDatabase();
    // Keep the old connection open so the backup must include committed WAL pages.
    const store = new SessionStore(path); cleanups.push(() => store.close());
    const session = store.acquire("old-session", "workspace");
    expect(session.selection).toEqual({ provider: "ollama", model: "legacy-model" });
    expect(store.messages(session.id)[0]?.content).toBe("Keep this history");
    store.setSelection(session.id, { provider: "openrouter", model: "new-model" });
    expect(store.switches(session.id)[0]).toMatchObject({ fromModel: "legacy-model", toModel: "new-model" });
    const backups = readdirSync(dirname(path)).filter((file) => file.includes(".v1-"));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(dirname(path), backups[0]!), { readonly: true });
    expect(backup.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(backup.query("SELECT content FROM messages").get()).toEqual({ content: "Keep this history" });
    backup.close();
});

test("refuses to migrate while an older process owns a session", () => {
    const { path, db } = legacyDatabase(true);
    expect(() => new SessionStore(path)).toThrow("Close other NightOwl processes");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(readdirSync(dirname(path)).filter((file) => file.includes(".v1-"))).toHaveLength(0);
});

test("model selection and switch event roll back together on failure", () => {
    const temp = temporaryDatabase(); cleanups.push(temp.cleanup);
    const store = new SessionStore(temp.path); cleanups.push(() => store.close());
    const session = store.create("workspace", { provider: "ollama", model: "old-model" });
    const db = new Database(temp.path);
    db.exec("CREATE TRIGGER refuse_switch BEFORE UPDATE OF selected_model ON sessions BEGIN SELECT RAISE(ABORT,'switch failed'); END;");
    db.close();
    expect(() => store.setSelection(session.id, { provider: "openrouter", model: "new-model" })).toThrow("switch failed");
    expect(store.list("workspace")[0]?.selection?.model).toBe("old-model");
    expect(store.switches(session.id)).toHaveLength(0);
});

test("upgrades v2 with a WAL-aware backup, preserving model selection and switches", () => {
    const { path, db } = legacyDatabase();
    db.exec(`
        ALTER TABLE sessions ADD COLUMN selected_provider TEXT;
        ALTER TABLE sessions ADD COLUMN selected_model TEXT;
        UPDATE sessions SET selected_provider='ollama', selected_model='legacy-model';
        CREATE TABLE model_switches (id TEXT PRIMARY KEY, session_id TEXT, from_provider TEXT, from_model TEXT,
            to_provider TEXT, to_model TEXT, created_at INTEGER);
        INSERT INTO model_switches VALUES ('switch','old-session','openrouter','previous','ollama','legacy-model',1);
        PRAGMA user_version = 2;
    `);
    const store = new SessionStore(path); cleanups.push(() => store.close());
    expect(store.acquire("old-session", "workspace").selection?.model).toBe("legacy-model");
    expect(store.switches("old-session")).toHaveLength(1);
    expect(store.messages("old-session")[0]?.content).toBe("Keep this history");
    expect(store.contextState("old-session")).toEqual({ notes: "", forceCompact: false, overrides: {} });
    const backupName = readdirSync(dirname(path)).find((name) => name.includes(".v2-"))!;
    const backup = new Database(join(dirname(path), backupName), { readonly: true });
    expect(backup.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(backup.query("SELECT content FROM messages").get()).toEqual({ content: "Keep this history" });
    backup.close();
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
});
