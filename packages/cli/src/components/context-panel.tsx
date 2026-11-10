import { useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { InputRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { contextBudget, selectionKey, type ContextReport } from "@nightowl/core";
import { useChat } from "../providers/chat";
import { useToast } from "../providers/toast";

export function ContextPanel({ initialPage }: { initialPage: "context" | "memory" }) {
    const chat = useChat();
    const toast = useToast();
    const { height } = useTerminalDimensions();
    const [page, setPage] = useState<"context" | "memory" | "window" | "output">(initialPage);
    const [error, setError] = useState("");
    const [last, setLast] = useState(false);
    const [field, setField] = useState("");
    const [windowLimit, setWindowLimit] = useState(4096);
    const notes = useRef<TextareaRenderable | null>(null);
    const input = useRef<InputRenderable | null>(null);
    const scroll = useRef<ScrollBoxRenderable | null>(null);
    const budget = contextBudget(chat.config, chat.contextState.overrides[selectionKey(chat.config)]);
    const preview = useMemo(() => {
        try { return { report: chat.previewContext().report, error: "" }; }
        catch (failure) { return { report: null, error: failure instanceof Error ? failure.message : String(failure) }; }
    }, [chat.messages, chat.config, chat.contextState]);
    const report: ContextReport | null = last ? chat.lastContext : preview.report;
    const attempt = (action: () => void) => {
        try { action(); setError(""); }
        catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    };
    useKeyboard((key) => {
        if (key.name === "escape") {
            key.preventDefault();
            if (page === "context" || initialPage === "memory") chat.closeContext();
            else { setPage("context"); setError(""); }
            return;
        }
        if (page === "memory") {
            if (key.ctrl && key.name === "s") {
                key.preventDefault(); attempt(() => {
                    chat.setNotes(notes.current?.plainText ?? ""); chat.closeContext();
                    toast.show({ message: "Task notes saved for this conversation.", variant: "success" });
                });
            }
            return;
        }
        if (page === "window" || page === "output") {
            if (key.name === "return" || key.name === "enter") {
                key.preventDefault(); attempt(() => {
                    const text = (input.current?.value ?? field).trim();
                    if (!/^\d+$/.test(text)) throw new Error("Enter a whole number of tokens.");
                    const value = Number(text);
                    if (page === "window") {
                        if (value < 1024 || value > 2_000_000) throw new Error("Choose a window from 1,024 to 2,000,000 tokens.");
                        setWindowLimit(value); setField(String(Math.min(budget.maxOutputTokens, Math.floor(value / 4)))); setPage("output");
                    } else { chat.setContextLimits({ contextWindow: windowLimit, maxOutputTokens: value }); setPage("context"); setLast(false); }
                });
            }
            return;
        }
        if (key.name === "up" || key.name === "down") { key.preventDefault(); scroll.current?.scrollBy(key.name === "up" ? -3 : 3); }
        if (key.ctrl || key.meta || key.option) return;
        if (key.name === "b") { setField(String(budget.contextWindow)); setPage("window"); }
        if (key.name === "e") setPage("memory");
        if (key.name === "l") { setLast((value) => !value); scroll.current?.scrollTo(0); }
        if (key.name === "c") attempt(() => { chat.compact(); setLast(false); });
        if (key.name === "r") attempt(() => { chat.restoreFullContext(); setLast(false); });
        if (key.name === "d") attempt(() => { chat.setContextLimits(); setLast(false); });
    });

    return <box position="absolute" top={1} width="96%" maxWidth={90} height={Math.max(10, height - 2)} border padding={1} backgroundColor="#1A1A24" zIndex={20}>
        <text flexShrink={0}>{page === "memory" ? "Task memory" : "Context inspector"}</text>
        {page === "memory" ? <>
            <text flexShrink={0} fg="gray" wrapMode="word">User-maintained notes for this conversation. Included in full on every request; never automatically inferred.</text>
            <textarea ref={notes} initialValue={chat.contextState.notes} focused flexGrow={1} minHeight={3} placeholder="Goal, constraints, decisions, next steps…" />
            <text flexShrink={0} fg="gray">Ctrl+S save · Esc cancel · clear the text and save to remove notes</text>
        </> : page === "window" || page === "output" ? <>
            <text>{page === "window" ? "Total context window (tokens)" : "Maximum reply tokens"}</text>
            <input ref={input} key={page} value={field} onInput={setField} focused />
            <text fg="gray" wrapMode="word">Saved for this model in this conversation. For Ollama, match the server's effective num_ctx; this setting does not change the server.</text>
            <text fg="gray">Enter continue/save · Esc cancel</text>
        </> : <>
            <text flexShrink={0} fg="gray">{chat.config.model} · {chat.config.provider}</text>
            <text flexShrink={0}>{last ? "Last saved request/compaction record" : "Current history preview (before your next message)"}</text>
            <scrollbox ref={scroll} flexGrow={1} flexBasis={0} minHeight={0}>
                <box gap={1}>
                    {last && chat.lastContext && <text fg="gray">{chat.lastContext.provider} · {chat.lastContext.model} · {new Date(chat.lastContext.createdAt).toLocaleString()}</text>}
                    <text wrapMode="word">Window {(report?.budget ?? budget).contextWindow.toLocaleString()} · reply {(report?.budget ?? budget).maxOutputTokens.toLocaleString()} · safety {(report?.budget ?? budget).safetyMargin.toLocaleString()}</text>
                    <text fg="gray" wrapMode="word">Limit source: {(report?.budget ?? budget).source}</text>
                    <text fg="gray" wrapMode="word">Counts are conservative UTF-8 byte estimates plus message overhead, not billed tokens. Model tokenizers and server templates differ.</text>
                    {!last && preview.error && <text fg="#F44336" wrapMode="word">{preview.error}</text>}
                    {last && !report && <text>No saved context record yet.</text>}
                    {report && <>
                        <text wrapMode="word">Estimated input {report.estimatedTokens.toLocaleString()} / {report.budget.inputBudget.toLocaleString()} · before compaction {report.originalTokens.toLocaleString()}</text>
                        <text wrapMode="word">Whole messages: {report.retainedIds.length} · older sources: {report.sourceIds.length} · excluded messages: {report.excludedIds.length}</text>
                        <text fg="gray" wrapMode="word">Kept IDs: {report.retainedIds.join(", ") || "none"}</text>
                        <text fg="gray" wrapMode="word">Older source IDs: {report.sourceIds.join(", ") || "none"}</text>
                        <text fg="gray" wrapMode="word">Excluded IDs: {report.excludedIds.join(", ") || "none"}</text>
                        <text wrapMode="word">{report.summary || "No older excerpts included."}</text>
                        {last && <text wrapMode="word">Task notes in that record: {report.notes || "none"}</text>}
                    </>}
                    <text wrapMode="word">Current task notes (user, session scope): {chat.contextState.notes || "none"}</text>
                    <text fg="gray" wrapMode="word">{chat.contextState.forceCompact ? "Manual compaction is on." : "Full history is used when it fits."} Originals stay saved. Local excerpts are lossy; pin essential facts in task notes.</text>
                </box>
            </scrollbox>
            <text flexShrink={0} fg="gray">B limits · D default limits · E edit notes · L preview/last record</text>
            <text flexShrink={0} fg="gray">C compact · R full when it fits · ↑/↓ scroll · Esc close</text>
        </>}
        {error && <text flexShrink={0} fg="#F44336" wrapMode="word">{error}</text>}
    </box>;
}
