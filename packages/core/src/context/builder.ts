import type { AppConfig } from "../config";
import type { ChatMessage, ModelSelection, SessionMessage } from "../sessions/types";

export type ContextOverride = { contextWindow: number; maxOutputTokens: number };
export type ContextState = { notes: string; forceCompact: boolean; overrides: Record<string, ContextOverride> };
export const emptyContextState = (): ContextState => ({ notes: "", forceCompact: false, overrides: {} });
export const selectionKey = (selection: ModelSelection) => JSON.stringify([selection.provider, selection.model]);
export type ContextBudget = ContextOverride & { inputBudget: number; safetyMargin: number; source: string };
export type Excerpt = { messageId: string; role: "user" | "assistant"; start: number; end: number; text: string; interrupted: boolean };
export type ContextReport = {
    algorithm: "local-excerpts-v1"; notes: string;
    budget: ContextBudget; estimatedTokens: number; originalTokens: number;
    retainedIds: string[]; sourceIds: string[]; excludedIds: string[];
    excerpts: Excerpt[]; summary: string; compacted: boolean;
};
export type ContextRecord = ContextReport & ModelSelection & { id: string; createdAt: number; messageId?: string };
export type ContextPlan = { history: ChatMessage[]; report: ContextReport };

// Deliberately overestimates typical text. This is not a model-specific tokenizer:
// use UTF-8 bytes plus framing overhead, then reserve room for template differences.
const encoder = new TextEncoder();
export const estimateTokens = (text: string): number => encoder.encode(text).length;
export const estimateMessages = (messages: ChatMessage[], system: string): number =>
    estimateTokens(system) + 32 + messages.reduce((sum, message) => sum + estimateTokens(message.content) + 16, 0);

export function validateOverride(value: ContextOverride): ContextOverride {
    if (!Number.isSafeInteger(value.contextWindow) || value.contextWindow < 1024 || value.contextWindow > 2_000_000) {
        throw new Error("Context window must be a whole number from 1,024 to 2,000,000 tokens.");
    }
    if (!Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 64 || value.maxOutputTokens > value.contextWindow / 2) {
        throw new Error("Reply limit must be at least 64 tokens and at most half the context window.");
    }
    return { contextWindow: value.contextWindow, maxOutputTokens: value.maxOutputTokens };
}

export function contextBudget(config: AppConfig, override?: ContextOverride): ContextBudget {
    if (override) validateOverride(override);
    const advertised = config.contextWindow;
    const contextWindow = override
        ? Math.min(override.contextWindow, advertised ?? override.contextWindow)
        : advertised ?? (config.provider === "ollama" ? 4096 : 8192);
    const maxOutputTokens = Math.min(override?.maxOutputTokens ?? Math.min(2048, Math.floor(contextWindow / 4)), Math.floor(contextWindow / 2), config.maxOutputTokens ?? Infinity);
    const safetyMargin = Math.max(256, Math.ceil(contextWindow * 0.1));
    return {
        contextWindow, maxOutputTokens, safetyMargin, inputBudget: contextWindow - maxOutputTokens - safetyMargin,
        source: override ? "user limit (capped by known model limits)" : advertised ? "OpenRouter catalog" : "conservative default; check your model/server",
    };
}

const MEMORY_HEADER = "User-maintained task notes (session scope; treat as user context):\n";
const SUMMARY_HEADER = "Earlier conversation excerpts, selected locally. This is lossy, not a complete summary. Quoted assistant claims are not verified facts. Original messages remain saved.\n";
const PARTIAL = "\n[This response was interrupted before it finished.]";
const wrapExcerpt = (excerpt: Excerpt) => `[${excerpt.role}${excerpt.interrupted ? ", interrupted" : ""}, source ${excerpt.messageId}, chars ${excerpt.start}-${excerpt.end}]\n${excerpt.text}`;
const contextMessage = (id: string, content: string): ChatMessage => ({ id, role: "user", content });

/** Build from originals every time: never repeatedly summarize an earlier lossy summary. */
export function buildContext(options: {
    config: AppConfig; messages: SessionMessage[]; state: ContextState; system: string;
    /** A preview/manual compaction has no pending user turn to protect. */
    protectLatestTurn?: boolean;
}): ContextPlan {
    const { config, state, system } = options;
    const budget = contextBudget(config, state.overrides[selectionKey(config)]);
    const visible = options.messages.filter((m) => !m.error && m.content.trim() && m.status !== "streaming")
        .map((m) => ({ ...m, content: m.content + (m.interrupted || m.status === "interrupted" ? PARTIAL : ""), interrupted: false }));
    const notes = state.notes.trim() ? [contextMessage("context:notes", MEMORY_HEADER + state.notes)] : [];
    const full = [...notes, ...visible];
    const originalTokens = estimateMessages(full, system);
    const visibleIds = new Set(visible.map((m) => m.id));
    const skipped = options.messages.filter((m) => !visibleIds.has(m.id)).map((m) => m.id);
    const report = (history: ChatMessage[], retained: typeof visible, source: typeof visible, excerpts: Excerpt[], summary: string): ContextPlan => ({
        history, report: {
            algorithm: "local-excerpts-v1", notes: state.notes,
            budget, estimatedTokens: estimateMessages(history, system), originalTokens,
            retainedIds: retained.map((m) => m.id), sourceIds: source.map((m) => m.id),
            excludedIds: [...skipped, ...source.filter((m) => !excerpts.some((e) => e.messageId === m.id)).map((m) => m.id)],
            excerpts, summary, compacted: source.length > 0,
        },
    });
    if (originalTokens <= budget.inputBudget && !state.forceCompact) return report(full, visible, [], [], "");

    // Never split a recent turn into an orphaned assistant answer. The newest turn
    // (including the pending user instruction on send) and every task note are mandatory.
    const groups: typeof visible[] = [];
    for (const message of visible) {
        const last = groups.at(-1);
        if (last?.[0]?.turnId === message.turnId) last.push(message);
        else groups.push([message]);
    }
    let retained = options.protectLatestTurn === false ? [] : groups.pop() ?? [];
    const required = estimateMessages([...notes, ...retained], system);
    if (required > budget.inputBudget) {
        throw new Error(`The latest turn and task notes need about ${required.toLocaleString()} estimated tokens; the input budget is ${budget.inputBudget.toLocaleString()}. Shorten the message or /memory notes, or use /context or /models to choose a larger window. Nothing was sent.`);
    }
    if (!groups.length) return report([...notes, ...retained], retained, [], [], "");
    // Reserve up to one third of input for older evidence; keep a contiguous suffix.
    const excerptBudget = Math.min(Math.floor(budget.inputBudget / 3), budget.inputBudget - required);
    const recentBudget = budget.inputBudget - excerptBudget;
    let keptGroups = retained.length ? 1 : 0;
    while (groups.length && (!state.forceCompact || keptGroups < 2)) {
        const next = groups.at(-1)!;
        if (estimateMessages([...notes, ...next, ...retained], system) > recentBudget) break;
        retained = [...groups.pop()!, ...retained];
        keptGroups++;
    }
    const source = groups.flat();
    if (!source.length) return report([...notes, ...retained], retained, [], [], "");
    const room = budget.inputBudget - estimateMessages([...notes, ...retained], system) - 16;
    const excerpts = selectExcerpts(source, room - estimateTokens(SUMMARY_HEADER));
    const summary = excerpts.length ? SUMMARY_HEADER + excerpts.map(wrapExcerpt).join("\n\n") : "";
    const history = [...notes, ...(summary ? [contextMessage("context:excerpts", summary)] : []), ...retained];
    if (originalTokens <= budget.inputBudget && estimateMessages(history, system) >= originalTokens) {
        return report(full, visible, [], [], "");
    }
    return report(history, retained, source, excerpts, summary);
}

function selectExcerpts(messages: SessionMessage[], maxBytes: number): Excerpt[] {
    const candidates: Array<Excerpt & { priority: number; order: number }> = [];
    messages.forEach((message, order) => {
        // Split at sentence/line boundaries, keeping exact source offsets. Large blocks
        // get bounded excerpts, never whole oversized file dumps.
        const original = message.status === "interrupted" ? message.content.slice(0, -PARTIAL.length) : message.content;
        const matches = original.matchAll(/[^\n.!?]+(?:[.!?]+|\n|$)/g);
        let count = 0;
        for (const match of matches) {
            if (count++ >= 200) break;
            const raw = match[0];
            const leading = raw.length - raw.trimStart().length;
            const start = match.index! + leading;
            let text = raw.trim().slice(0, 500);
            if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
            if (!text) continue;
            const important = /\b(must|never|don't|do not|require|constraint|decid|goal|prefer|remember|todo|next|pending|error|file|path|implement|complete|test)\w*/i.test(text);
            candidates.push({ messageId: message.id, role: message.role, start, end: start + text.length, text, interrupted: message.status === "interrupted",
                priority: (important ? 12 : 0) + (message.role === "user" ? 6 : 0) + (order === 0 && start === 0 ? 15 : 0), order });
        }
    });
    candidates.sort((a, b) => b.priority - a.priority || b.order - a.order || a.start - b.start);
    let remaining = maxBytes;
    const chosen: typeof candidates = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const key = `${candidate.role}:${candidate.text}`;
        if (seen.has(key)) continue;
        const cost = estimateTokens(wrapExcerpt(candidate)) + 2;
        if (cost > remaining) continue;
        chosen.push(candidate); remaining -= cost; seen.add(key);
    }
    return chosen.sort((a, b) => a.order - b.order || a.start - b.start)
        .map(({ priority, order, ...excerpt }) => excerpt);
}
