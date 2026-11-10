import { openSync, closeSync, fstatSync, readFileSync, writeFileSync } from "node:fs";
import type { SessionMessage } from "./types";

export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
export type PortableMessage = Pick<SessionMessage, "id" | "turnId" | "role" | "content" | "status" | "createdAt" | "provider" | "model" | "error">;
export type PortableSession = { format: "nightowl-session"; version: 1; title: string; notes: string; messages: PortableMessage[] };

function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session export object.");
    if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unsupported field in session export. Credentials, tools, and configuration cannot be imported.");
    return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, name: string, empty = false): string {
    if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum) throw new Error(`Invalid ${name} in session export.`);
    return value;
}
export function validateTitle(value: string) {
    const title = value.trim();
    if (!title || title.length > 70 || /[\x00-\x1f\x7f]/.test(title)) throw new Error("Use a title of 1–70 characters without control characters.");
    return title;
}
export function parseSessionExport(raw: string): PortableSession {
    if (Buffer.byteLength(raw, "utf8") > MAX_EXPORT_BYTES) throw new Error("Session exports must be at most 10 MiB.");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("The session export is not valid JSON."); }
    const root = object(value, ["format", "version", "title", "notes", "messages"]);
    if (root.format !== "nightowl-session" || root.version !== 1) throw new Error("Unsupported NightOwl session export version.");
    const title = validateTitle(text(root.title, 70, "title"));
    const notes = text(root.notes, 16000, "task notes", true);
    if (!Array.isArray(root.messages) || root.messages.length > 20000) throw new Error("Invalid message list in session export.");
    const ids = new Set<string>();
    const turns = new Set<string>();
    let lastTurn = "";
    let lastRole = "";
    const messages: PortableMessage[] = root.messages.map((entry) => {
        const row = object(entry, ["id", "turnId", "role", "content", "status", "createdAt", "provider", "model", "error"]);
        const id = text(row.id, 128, "message ID");
        const turnId = text(row.turnId, 128, "turn ID");
        if (ids.has(id)) throw new Error("Duplicate message ID in session export.");
        ids.add(id);
        if (row.role !== "user" && row.role !== "assistant") throw new Error("Only text chat messages can be imported.");
        if (turnId !== lastTurn) {
            if (turns.has(turnId) || row.role !== "user") throw new Error("Every imported turn must begin with its user message.");
            turns.add(turnId); lastTurn = turnId; lastRole = "";
        } else if (row.role !== "assistant" || lastRole !== "user") throw new Error("Invalid message order in session export.");
        lastRole = row.role;
        if (typeof row.status !== "string" || !["completed", "interrupted", "failed", "streaming"].includes(row.status)) throw new Error("Invalid message status in session export.");
        if (!Number.isSafeInteger(row.createdAt) || (row.createdAt as number) < 0) throw new Error("Invalid timestamp in session export.");
        const content = text(row.content, 1_000_000, "message content", row.role === "assistant");
        const message: PortableMessage = { id, turnId, role: row.role, content,
            status: row.status === "streaming" ? "interrupted" : row.status as PortableMessage["status"], createdAt: row.createdAt as number };
        if (row.role === "assistant") {
            if (row.provider !== "ollama" && row.provider !== "openrouter") throw new Error("Unsupported assistant provider in session export.");
            message.provider = row.provider;
            message.model = text(row.model, 256, "model");
            if (/\s|[\x00-\x1f\x7f]/.test(message.model)) throw new Error("Invalid model ID in session export.");
        } else if (row.provider !== undefined || row.model !== undefined || row.error !== undefined || row.status !== "completed") {
            throw new Error("User messages must be completed text without provider or error metadata.");
        }
        if (row.error !== undefined) message.error = text(row.error, 10000, "error", true);
        if (message.status === "failed" && !message.error) message.error = "Imported failed reply";
        return message;
    });
    return { format: "nightowl-session", version: 1, title, notes, messages };
}

export function readSessionExport(path: string) {
    const descriptor = openSync(path, "r");
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.size > MAX_EXPORT_BYTES) throw new Error("Choose a session JSON file no larger than 10 MiB.");
        return parseSessionExport(readFileSync(descriptor, "utf8"));
    } finally { closeSync(descriptor); }
}

/** Never overwrite an existing file, including credentials or another export. */
export function writeSessionExport(path: string, data: PortableSession) {
    const raw = JSON.stringify(data, null, 2) + "\n";
    parseSessionExport(raw);
    writeFileSync(path, raw, { flag: "wx", mode: 0o600 });
}
