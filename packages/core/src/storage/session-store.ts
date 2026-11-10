import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Attempt, MessageStatus, ModelSelection, ModelSwitch, Session, SessionMessage, StartedTurn } from "../sessions/types";
import { emptyContextState, type ContextState, type ContextRecord } from "../context/builder";
import { parseSessionExport, validateTitle, type PortableSession } from "../sessions/portable";

const CONTEXT_SCHEMA = `
    CREATE TABLE IF NOT EXISTS context_state (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id), notes TEXT NOT NULL,
        force_compact INTEGER NOT NULL, overrides_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS context_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        message_id TEXT REFERENCES messages(id), record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS context_runs_session ON context_runs(session_id);
`;

type SessionRow = {
    id: string; workspace: string; title: string; created_at: number; updated_at: number;
    owner: string | null; owner_pid: number | null;
    selected_provider: ModelSelection["provider"] | null; selected_model: string | null;
};
type MessageRow = {
    id: string; session_id: string; turn_id: string; role: "user" | "assistant";
    content: string; status: MessageStatus; created_at: number;
    provider: ModelSelection["provider"] | null; model: string | null; error: string | null;
};

function sessionFrom(row: SessionRow): Session {
    return {
        id: row.id, workspace: row.workspace, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at,
        ...(row.selected_provider && row.selected_model ? { selection: { provider: row.selected_provider, model: row.selected_model } } : {}),
    };
}

function messageFrom(row: MessageRow): SessionMessage {
    return {
        id: row.id, sessionId: row.session_id, turnId: row.turn_id, role: row.role,
        content: row.content, status: row.status, createdAt: row.created_at,
        ...(row.provider ? { provider: row.provider, model: row.model! } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(row.status === "interrupted" ? { interrupted: true } : {}),
    };
}

function processIsAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) {
        // Permission errors are not proof that the other process has died.
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

/** Synchronous transactions keep accepted user input durable before any HTTP call. */
export class SessionStore {
    private readonly db: Database;
    private readonly owner = crypto.randomUUID();
    private closed = false;

    constructor(path: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new Database(path, { create: true, strict: true });
        try {
            this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
            const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
            if (version > 3) throw new Error("This session database was created by a newer NightOwl. Upgrade NightOwl to open it.");
            this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
            if (version === 0) this.migrate();
            if (version === 1 || version === 2) this.upgrade(path);
        } catch (error) {
            this.db.close();
            throw error;
        }
    }

    private migrate() {
        this.db.transaction(() => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, opened_at INTEGER NOT NULL,
                    owner TEXT, owner_pid INTEGER, selected_provider TEXT, selected_model TEXT
                );
                CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace, opened_at DESC);
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), turn_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('streaming','completed','interrupted','failed')),
                    created_at INTEGER NOT NULL, provider TEXT, model TEXT, error TEXT
                );
                CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id);
                CREATE TABLE IF NOT EXISTS attempts (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
                    message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), provider TEXT NOT NULL, model TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('streaming','completed','interrupted','failed')),
                    started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT
                );
                CREATE TABLE IF NOT EXISTS model_switches (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
                    from_provider TEXT, from_model TEXT, to_provider TEXT NOT NULL, to_model TEXT NOT NULL, created_at INTEGER NOT NULL
                );
                ${CONTEXT_SCHEMA}
                PRAGMA user_version = 3;
            `);
        }).immediate();
    }

    private upgrade(path: string) {
        this.db.transaction(() => {
            const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
            if (version >= 3) return; // Another process may have completed the migration while we waited.
            const owners = this.db.query<{ owner_pid: number }, []>("SELECT owner_pid FROM sessions WHERE owner IS NOT NULL AND owner_pid IS NOT NULL").all();
            if (owners.some((row) => processIsAlive(row.owner_pid))) throw new Error("Close other NightOwl processes before upgrading saved sessions.");
            // serialize() includes committed WAL content. Back up before the first schema change.
            if (path !== ":memory:") writeFileSync(`${path}.v${version}-${Date.now()}-${crypto.randomUUID()}.sqlite`, this.db.serialize(), { flag: "wx", mode: 0o600 });
            if (version === 1) this.db.exec(`
                ALTER TABLE sessions ADD COLUMN selected_provider TEXT;
                ALTER TABLE sessions ADD COLUMN selected_model TEXT;
                UPDATE sessions SET
                    selected_provider = (SELECT provider FROM attempts WHERE session_id = sessions.id ORDER BY rowid DESC LIMIT 1),
                    selected_model = (SELECT model FROM attempts WHERE session_id = sessions.id ORDER BY rowid DESC LIMIT 1);
                CREATE TABLE model_switches (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
                    from_provider TEXT, from_model TEXT, to_provider TEXT NOT NULL, to_model TEXT NOT NULL, created_at INTEGER NOT NULL
                );
            `);
            this.db.exec(`${CONTEXT_SCHEMA} PRAGMA user_version = 3;`);
        }).immediate();
    }

    list(workspace: string): Session[] {
        return this.db.query<SessionRow, [string]>(
            "SELECT * FROM sessions WHERE workspace = ? ORDER BY opened_at DESC, rowid DESC",
        ).all(workspace).map(sessionFrom);
    }

    create(workspace: string, selection?: ModelSelection): Session {
        const now = Date.now();
        const id = crypto.randomUUID();
        this.db.query(`INSERT INTO sessions (id,workspace,title,created_at,updated_at,opened_at,owner,owner_pid,selected_provider,selected_model)
            VALUES (?,?,'New conversation',?,?,?,?,?,?,?)`).run(id, workspace, now, now, now, this.owner, process.pid, selection?.provider ?? null, selection?.model ?? null);
        return { id, workspace, title: "New conversation", createdAt: now, updatedAt: now, selection };
    }

    /** Acquires the session and recovers orphaned requests, never another live writer's requests. */
    acquire(id: string, workspace: string): Session {
        return this.db.transaction(() => {
            const row = this.db.query<SessionRow, [string, string]>(
                "SELECT * FROM sessions WHERE id = ? AND workspace = ?",
            ).get(id, workspace);
            if (!row) throw new Error("Session not found in this workspace. Use --sessions to list its saved chats.");
            if (row.owner && row.owner !== this.owner && row.owner_pid !== null && processIsAlive(row.owner_pid)) {
                throw new Error("This session is open in another NightOwl process. Close it there or launch with --new.");
            }
            if (row.owner !== this.owner) {
                this.db.query("UPDATE messages SET status = 'interrupted' WHERE session_id = ? AND status = 'streaming'").run(id);
                this.db.query("UPDATE attempts SET status = 'interrupted', finished_at = ? WHERE session_id = ? AND status = 'streaming'")
                    .run(Date.now(), id);
            }
            this.db.query("UPDATE sessions SET owner = ?, owner_pid = ?, opened_at = ? WHERE id = ?")
                .run(this.owner, process.pid, Date.now(), id);
            return sessionFrom(row);
        }).immediate();
    }

    release(id: string) {
        this.db.query("UPDATE sessions SET owner = NULL, owner_pid = NULL WHERE id = ? AND owner = ?").run(id, this.owner);
    }

    private assertOwned(id: string) {
        const row = this.db.query("SELECT id FROM sessions WHERE id = ? AND owner = ?").get(id, this.owner);
        if (!row) throw new Error("NightOwl no longer owns this session; reopen it before sending another message.");
    }

    messages(id: string): SessionMessage[] {
        return this.db.query<MessageRow, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid").all(id).map(messageFrom);
    }

    rename(id: string, title: string) {
        const clean = validateTitle(title);
        this.db.transaction(() => {
            this.assertOwned(id);
            this.db.query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(clean, Date.now(), id);
        }).immediate();
        return clean;
    }

    exportSession(id: string, workspace: string): PortableSession {
        return this.db.transaction(() => {
            const row = this.db.query<SessionRow, [string, string]>("SELECT * FROM sessions WHERE id = ? AND workspace = ?").get(id, workspace);
            if (!row) throw new Error("Session not found in this workspace.");
            return { format: "nightowl-session" as const, version: 1 as const, title: row.title,
                notes: this.contextState(id).notes,
                messages: this.messages(id).map(({ id, turnId, role, content, status, createdAt, provider, model, error }) => ({
                    id, turnId, role, content, status: status === "streaming" ? "interrupted" as const : status,
                    createdAt, provider, model, error,
                })),
            };
        })();
    }

    importSession(input: PortableSession, workspace: string, selection?: ModelSelection): Session {
        const data = parseSessionExport(JSON.stringify(input));
        return this.db.transaction(() => {
            // Workspace, selected provider, limits, and permissions come from this machine.
            const session = this.create(workspace, selection);
            session.title = this.rename(session.id, data.title);
            const turnIds = new Map<string, string>();
            for (const message of data.messages) {
                if (!turnIds.has(message.turnId)) turnIds.set(message.turnId, crypto.randomUUID());
                const id = crypto.randomUUID();
                this.db.query(`INSERT INTO messages (id,session_id,turn_id,role,content,status,created_at,provider,model,error)
                    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, session.id, turnIds.get(message.turnId)!, message.role, message.content,
                        message.status, message.createdAt, message.provider ?? null, message.model ?? null, message.error ?? null);
                // An imported reply is transcript evidence, not a newly executed request.
                // Its original request timing/attempt ID is deliberately not fabricated.
            }
            this.saveContextState(session.id, { ...emptyContextState(), notes: data.notes });
            return session;
        }).immediate();
    }

    startTurn(id: string, text: string, selection: ModelSelection, configError?: string): StartedTurn {
        return this.db.transaction((): StartedTurn => {
            this.assertOwned(id);
            const now = Date.now();
            const turnId = crypto.randomUUID();
            const userId = crypto.randomUUID();
            const assistantId = crypto.randomUUID();
            const attemptId = crypto.randomUUID();
            const status = configError ? "failed" : "streaming";
            const first = !this.db.query("SELECT id FROM messages WHERE session_id = ? LIMIT 1").get(id);
            const insert = this.db.query(`INSERT INTO messages
                (id,session_id,turn_id,role,content,status,created_at,provider,model,error) VALUES (?,?,?,?,?,?,?,?,?,?)`);
            insert.run(userId, id, turnId, "user", text, "completed", now, null, null, null);
            insert.run(assistantId, id, turnId, "assistant", "", status, now, selection.provider, selection.model, configError ?? null);
            this.db.query(`INSERT INTO attempts (id,session_id,message_id,provider,model,status,started_at,finished_at,error)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(attemptId, id, assistantId, selection.provider, selection.model, status, now, configError ? now : null, configError ?? null);
            const unnamed = this.db.query<{ title: string }, [string]>("SELECT title FROM sessions WHERE id = ?").get(id)?.title === "New conversation";
            if (first && unnamed) {
                this.db.query("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
                    .run(text.replace(/\s+/g, " ").slice(0, 70), now, id);
            } else this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, id);
            return {
                user: { id: userId, sessionId: id, turnId, role: "user", content: text, status: "completed", createdAt: now },
                assistant: {
                    id: assistantId, sessionId: id, turnId, role: "assistant", content: "", status, createdAt: now,
                    provider: selection.provider, model: selection.model, ...(configError ? { error: configError } : {}),
                },
                attemptId,
            };
        }).immediate();
    }

    saveReply(sessionId: string, messageId: string, content: string, status: MessageStatus, error?: string) {
        this.db.transaction(() => {
            this.assertOwned(sessionId);
            const changed = this.db.query(`UPDATE messages SET content = ?, status = ?, error = ?
                WHERE id = ? AND session_id = ? AND status = 'streaming'`)
                .run(content, status, error ?? null, messageId, sessionId);
            if (changed.changes !== 1) throw new Error("Cannot save a reply that is no longer running.");
            const now = Date.now();
            this.db.query("UPDATE attempts SET status = ?, finished_at = ?, error = ? WHERE message_id = ?")
                .run(status, status === "streaming" ? null : now, error ?? null, messageId);
            this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
        }).immediate();
    }

    attempts(sessionId: string): Attempt[] {
        return this.db.query<Attempt, [string]>(`SELECT id, session_id AS sessionId, message_id AS messageId,
            provider, model, status, started_at AS startedAt, finished_at AS finishedAt, error
            FROM attempts WHERE session_id = ? ORDER BY rowid`).all(sessionId);
    }

    setSelection(sessionId: string, selection: ModelSelection) {
        this.db.transaction(() => {
            this.assertOwned(sessionId);
            const current = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(sessionId)!;
            if (current.selected_provider === selection.provider && current.selected_model === selection.model) return;
            const now = Date.now();
            this.db.query("INSERT INTO model_switches (id,session_id,from_provider,from_model,to_provider,to_model,created_at) VALUES (?,?,?,?,?,?,?)")
                .run(crypto.randomUUID(), sessionId, current.selected_provider, current.selected_model, selection.provider, selection.model, now);
            this.db.query("UPDATE sessions SET selected_provider = ?, selected_model = ?, updated_at = ? WHERE id = ?")
                .run(selection.provider, selection.model, now, sessionId);
        }).immediate();
    }

    switches(sessionId: string): ModelSwitch[] {
        return this.db.query<ModelSwitch, [string]>(`SELECT id, session_id AS sessionId,
            from_provider AS fromProvider, from_model AS fromModel, to_provider AS toProvider, to_model AS toModel, created_at AS createdAt
            FROM model_switches WHERE session_id = ? ORDER BY rowid`).all(sessionId);
    }

    close() {
        if (this.closed) return;
        try {
            this.db.query("UPDATE sessions SET owner = NULL, owner_pid = NULL WHERE owner = ?").run(this.owner);
        } finally {
            this.db.close();
            this.closed = true;
        }
    }

    contextState(sessionId: string): ContextState {
        const row = this.db.query<{ notes: string; force_compact: number; overrides_json: string }, [string]>(
            "SELECT notes, force_compact, overrides_json FROM context_state WHERE session_id = ?",
        ).get(sessionId);
        return row ? { notes: row.notes, forceCompact: !!row.force_compact, overrides: JSON.parse(row.overrides_json) } : emptyContextState();
    }

    saveContextState(sessionId: string, state: ContextState) {
        this.db.transaction(() => {
            this.assertOwned(sessionId);
            this.db.query(`INSERT INTO context_state (session_id,notes,force_compact,overrides_json) VALUES (?,?,?,?)
                ON CONFLICT(session_id) DO UPDATE SET notes=excluded.notes, force_compact=excluded.force_compact, overrides_json=excluded.overrides_json`)
                .run(sessionId, state.notes, state.forceCompact ? 1 : 0, JSON.stringify(state.overrides));
        }).immediate();
    }

    saveContextRecord(sessionId: string, record: ContextRecord, state?: ContextState) {
        this.db.transaction(() => {
            this.assertOwned(sessionId);
            if (state) this.saveContextState(sessionId, state);
            if (record.messageId && !this.db.query("SELECT id FROM messages WHERE id = ? AND session_id = ?").get(record.messageId, sessionId)) {
                throw new Error("Context must belong to a message in the current session.");
            }
            this.db.query("INSERT INTO context_runs (id,session_id,message_id,record_json) VALUES (?,?,?,?)")
                .run(record.id, sessionId, record.messageId ?? null, JSON.stringify(record));
        }).immediate();
    }

    latestContextRecord(sessionId: string): ContextRecord | null {
        const row = this.db.query<{ record_json: string }, [string]>("SELECT record_json FROM context_runs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1").get(sessionId);
        return row ? JSON.parse(row.record_json) : null;
    }
}
