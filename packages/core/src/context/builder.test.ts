import { describe, expect, test } from "bun:test";
import { buildContext, contextBudget, emptyContextState, estimateTokens, estimateMessages, selectionKey } from "./builder";
import { SYSTEM_PROMPT } from "../ai/chat";
import type { SessionMessage } from "../sessions/types";
import type { AppConfig } from "../config";

const config: AppConfig = { provider: "ollama", model: "small", baseURL: "http://localhost:0/v1" };
function turn(index: number, user: string, assistant: string): SessionMessage[] {
    return [{ role: "user" as const, content: user }, { role: "assistant" as const, content: assistant }].map((m, part) => ({
        ...m, id: `${index}-${part}`, turnId: `turn-${index}`, sessionId: "session", createdAt: index, status: "completed",
    }));
}
const build = (messages: SessionMessage[], state = emptyContextState(), selected = config) => buildContext({ config: selected, messages, state, system: SYSTEM_PROMPT });

describe("portable context budgets", () => {
    test("uses model limits, output reserve and framing overhead; counts Unicode conservatively", () => {
        expect(estimateTokens("hello")).toBe(5);
        expect(estimateTokens("你好🙂")).toBe(10);
        const budget = contextBudget({ ...config, provider: "openrouter", contextWindow: 32_000, maxOutputTokens: 800 });
        expect(budget).toMatchObject({ contextWindow: 32_000, maxOutputTokens: 800, inputBudget: 28_000, safetyMargin: 3200 });
        expect(contextBudget(config).source).toContain("default");
        expect(() => contextBudget(config, { contextWindow: 512, maxOutputTokens: 1 })).toThrow();
        expect(() => contextBudget(config, { contextWindow: NaN, maxOutputTokens: 128 })).toThrow();
        expect(contextBudget({ ...config, contextWindow: 4096 }, { contextWindow: 9000, maxOutputTokens: 500 }).contextWindow).toBe(4096);
        expect(contextBudget(config, { contextWindow: 9000, maxOutputTokens: 3000 }).maxOutputTokens).toBe(3000);
    });

    test("keeps full history when it fits and notes remain user context", () => {
        const messages = turn(0, "Use SQLite", "Agreed");
        const state = { ...emptyContextState(), notes: "Never add cloud sync." };
        const plan = build(messages, state);
        expect(plan.report.compacted).toBe(false);
        expect(plan.history.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
        expect(plan.history[0]?.content).toContain(state.notes);
        expect(plan.report.estimatedTokens).toBe(estimateMessages(plan.history, SYSTEM_PROMPT));
        const tiny = [...turn(0, "hi", "hello"), ...turn(1, "ok", "yes"), ...turn(2, "next", "done")];
        const compact = build(tiny, { ...emptyContextState(), forceCompact: true });
        expect(compact.report.estimatedTokens).toBeLessThanOrEqual(compact.report.originalTokens);
    });

    test("fits a smaller window with pinned facts, latest input, whole recent turns and source-linked excerpts", () => {
        const messages = [
            ...turn(0, "The goal is Project Sparrow. Never add cloud sync.", "Decided to use SQLite."),
            ...Array.from({ length: 12 }, (_, index) => turn(index + 1, `Review section ${index}. ${"filler ".repeat(130)}`, "No changes needed. ".repeat(20))).flat(),
            ...turn(20, "Which test is pending?", "The migration test is pending."),
            turn(21, "Continue using the constraints", "")[0]!,
        ];
        const before = JSON.stringify(messages);
        const state = { ...emptyContextState(), notes: "Project Sparrow; use SQLite; no cloud sync; next run migration tests." };
        const { report, history } = build(messages, state);
        expect(report.compacted).toBe(true);
        expect(report.estimatedTokens).toBeLessThanOrEqual(report.budget.inputBudget);
        expect(history.at(-1)?.content).toBe("Continue using the constraints");
        expect(history[0]?.content).toContain("no cloud sync");
        expect(report.summary).toContain("Project Sparrow");
        for (const excerpt of report.excerpts) {
            const original = messages.find((m) => m.id === excerpt.messageId)!;
            expect(original.content.slice(excerpt.start, excerpt.end)).toBe(excerpt.text);
        }
        for (const message of messages.filter((m) => m.role === "assistant" && report.retainedIds.includes(m.id))) {
            expect(report.retainedIds).toContain(messages.find((m) => m.turnId === message.turnId && m.role === "user")!.id);
        }
        expect(JSON.stringify(messages)).toBe(before);
        expect(report.excludedIds.length).toBeGreaterThan(0);
    });

    test("never truncates an oversized newest message or task notes", () => {
        expect(() => build(turn(0, "x".repeat(5000), ""))).toThrow("Nothing was sent");
        expect(() => build(turn(0, "short", ""), { ...emptyContextState(), notes: "x".repeat(5000) })).toThrow("task notes");
        const messages = turn(0, "A completed earlier turn", "large reply. ".repeat(500));
        const preview = buildContext({ config, messages, state: emptyContextState(), system: SYSTEM_PROMPT, protectLatestTurn: false });
        expect(preview.report.estimatedTokens).toBeLessThanOrEqual(preview.report.budget.inputBudget);
        expect(preview.report.sourceIds).toContain("0-1");
    });

    test("manual compaction is deterministic and excludes failed answers, marking interrupted evidence", () => {
        const messages = [...turn(0, "Remember the constraint: SQLite", "Started implementation. ".repeat(40)), ...turn(1, "next", "reply"), ...turn(2, "latest", "answer")];
        messages[1] = { ...messages[1]!, status: "interrupted", interrupted: true };
        messages[3] = { ...messages[3]!, status: "failed", error: "unavailable" };
        const state = { ...emptyContextState(), forceCompact: true };
        const first = build(messages, state);
        expect(first).toEqual(build(messages, state));
        expect(first.report.excludedIds).toContain("1-1");
        expect(first.history.some((m) => m.id === "1-1")).toBe(false);
        expect(first.report.summary).toContain("interrupted");
        for (const excerpt of first.report.excerpts) expect(messages.find((m) => m.id === excerpt.messageId)!.content.slice(excerpt.start, excerpt.end)).toBe(excerpt.text);
    });

    test("budgets stay bounded across different windows and mixed text, without losing pending input", () => {
        const messages = Array.from({ length: 25 }, (_, i) => turn(i, `Goal ${i}: 保留这个约束 🙂.\n${"const value = 1; ".repeat(i * 3)}`, "Result " + "done ".repeat(i * 4))).flat();
        messages.push(turn(30, "Next instruction intact", "")[0]!);
        for (const contextWindow of [1024, 2048, 4096, 8192, 32000]) {
            const state = emptyContextState();
            state.overrides[selectionKey(config)] = { contextWindow, maxOutputTokens: 128 };
            const plan = build(messages, state);
            expect(plan.report.estimatedTokens + plan.report.budget.maxOutputTokens + plan.report.budget.safetyMargin).toBeLessThanOrEqual(contextWindow);
            expect(plan.history.at(-1)?.content).toBe("Next instruction intact");
        }
    });
});
