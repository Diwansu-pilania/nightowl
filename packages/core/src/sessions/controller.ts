import type { LanguageModel } from "ai";
import { createModel } from "../ai/model";
import { describeError, streamReply, SYSTEM_PROMPT } from "../ai/chat";
import { getConfigProblem, type AppConfig } from "../config";
import { checkModelId } from "../providers/urls";
import { SessionStore } from "../storage/session-store";
import type { MessageStatus, ModelSelection, Session, SessionMessage } from "./types";
import { buildContext, selectionKey, validateOverride, emptyContextState, type ContextOverride, type ContextState, type ContextRecord, type ContextPlan } from "../context/builder";
import { readSessionExport, writeSessionExport } from "./portable";

export type SessionSnapshot = {
    config: AppConfig;
    session: Session;
    messages: SessionMessage[];
    status: "idle" | "streaming";
    /** A persistence failure blocks further sends; never silently continue without saving. */
    storageError: string | null;
    contextState: ContextState;
    lastContext: ContextRecord | null;
    contextError: string | null;
};

type ActiveRequest = {
    config: AppConfig;
    model: LanguageModel;
    abort: AbortController;
    sessionId: string;
    messageId: string;
    content: string;
    timer: ReturnType<typeof setTimeout> | null;
};

type ControllerOptions = {
    store: SessionStore;
    workspace: string;
    config: AppConfig;
    configProblem?: string | null;
    model?: LanguageModel;
    sessionId?: string;
    startNew?: boolean;
    checkpointMs?: number;
    resolveConfig?: (selection: ModelSelection) => AppConfig;
    modelFactory?: (config: AppConfig) => LanguageModel;
    /** Explicit environment model/provider choices override the saved session on launch. */
    preferConfig?: boolean;
};

/** Owns the request lifecycle independently of React or any particular model. */
export class SessionController {
    get config(): AppConfig { return this.snapshot.config; }
    private readonly store: SessionStore;
    private readonly workspace: string;
    private model: LanguageModel;
    private configProblem: string | null;
    private readonly modelFactory: (config: AppConfig) => LanguageModel;
    private readonly resolveConfig: (selection: ModelSelection) => AppConfig;
    private readonly checkpointMs: number;
    private snapshot: SessionSnapshot;
    private active: ActiveRequest | null = null;
    private readonly listeners = new Set<() => void>();
    private disposed = false;

    constructor(options: ControllerOptions) {
        this.store = options.store;
        this.workspace = options.workspace;
        this.configProblem = options.configProblem ?? null;
        this.modelFactory = options.modelFactory ?? (options.model ? () => options.model! : createModel);
        this.resolveConfig = options.resolveConfig ?? ((selection) => ({
            ...options.config, ...selection,
            ...(selection.model !== options.config.model || selection.provider !== options.config.provider ? { contextWindow: undefined, maxOutputTokens: undefined } : {}),
            ...(selection.provider !== options.config.provider ? { apiKey: undefined, baseURL: selection.provider === "openrouter" ? "https://openrouter.ai/api/v1" : "http://localhost:11434/v1" } : {}),
        }));
        this.checkpointMs = options.checkpointMs ?? 150;
        const id = options.sessionId ?? (options.startNew ? undefined : this.store.list(this.workspace)[0]?.id);
        const session = id ? this.store.acquire(id, this.workspace) : this.store.create(this.workspace, options.config);
        const config = session.selection && !options.preferConfig ? this.resolveConfig(session.selection) : options.config;
        this.model = this.modelFactory(config);
        if (!this.configProblem || config.provider !== options.config.provider) this.configProblem = getConfigProblem(config, {});
        this.store.setSelection(session.id, config);
        session.selection = { provider: config.provider, model: config.model };
        this.snapshot = { config, session, messages: this.store.messages(session.id), status: "idle", storageError: null,
            contextState: this.store.contextState(session.id), lastContext: this.store.latestContextRecord(session.id), contextError: null };
    }

    getSnapshot = (): SessionSnapshot => this.snapshot;

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    private publish(update: Partial<SessionSnapshot>) {
        this.snapshot = { ...this.snapshot, ...update };
        for (const listener of this.listeners) listener();
    }

    private updateReply(request: ActiveRequest, status: MessageStatus, error?: string) {
        this.publish({
            messages: this.snapshot.messages.map((message) => message.id === request.messageId ? {
                ...message, content: request.content, status,
                interrupted: status === "interrupted", error,
            } : message),
        });
    }

    private storageFailed(error: unknown) {
        this.publish({ storageError: `Could not save this session: ${error instanceof Error ? error.message : String(error)}. Keep this window open to copy any unsaved text; resolve the storage problem before reopening.` });
    }

    send = (rawText: string): boolean => {
        const text = rawText.trim();
        if (this.disposed || this.active || this.snapshot.storageError || !text) return false;
        const history = this.snapshot.messages;
        if (!this.configProblem) {
            try {
                // Keep oversized input in the editor; do not start a request or discard notes.
                this.prepareContext([...history, { id: "pending", turnId: "pending", sessionId: this.snapshot.session.id,
                    role: "user", content: text, status: "completed", createdAt: Date.now() }]);
            } catch (error) {
                this.publish({ contextError: error instanceof Error ? error.message : String(error) });
                return false;
            }
        }
        let turn;
        try {
            // Only a provider/model pair crosses the storage boundary, never the API key/config.
            turn = this.store.startTurn(this.snapshot.session.id, text, {
                provider: this.config.provider, model: this.config.model,
            }, this.configProblem ?? undefined);
        } catch (error) {
            this.storageFailed(error);
            return false;
        }
        const request: ActiveRequest = {
            config: this.config, model: this.model,
            abort: new AbortController(), sessionId: this.snapshot.session.id,
            messageId: turn.assistant.id, content: "", timer: null,
        };
        if (!this.configProblem) this.active = request;
        this.publish({
            session: {
                ...this.snapshot.session, updatedAt: Date.now(),
                ...(history.length === 0 && this.snapshot.session.title === "New conversation" ? { title: text.replace(/\s+/g, " ").slice(0, 70) } : {}),
            },
            messages: [...history, turn.user, turn.assistant],
            status: this.configProblem ? "idle" : "streaming",
            contextError: null,
        });
        if (!this.configProblem) void this.run(request, [...history, turn.user]);
        return true;
    };

    private async run(request: ActiveRequest, history: SessionMessage[]) {
        let plan: ContextPlan;
        try {
            plan = this.prepareContext(history);
            this.recordContext(plan, history.at(-1)!.id);
        } catch (error) {
            this.storageFailed(error);
            this.finish(request, "failed", "Could not save the context record. Nothing was sent.");
            return;
        }
        try {
            const result = await streamReply({
                model: request.model, history: plan.history, signal: request.abort.signal,
                maxOutputTokens: plan.report.budget.maxOutputTokens,
                onText: (delta) => {
                    if (this.active !== request || this.disposed) return;
                    request.content += delta;
                    this.updateReply(request, "streaming");
                    if (!request.timer) {
                        request.timer = setTimeout(() => {
                            request.timer = null;
                            if (this.active !== request) return;
                            try {
                                this.store.saveReply(request.sessionId, request.messageId, request.content, "streaming");
                            } catch (error) {
                                this.storageFailed(error);
                                this.stop();
                            }
                        }, this.checkpointMs);
                        request.timer.unref();
                    }
                },
            });
            this.finish(request, result.aborted || result.truncated ? "interrupted" : "completed");
        } catch (error) {
            this.finish(request, request.abort.signal.aborted ? "interrupted" : "failed", describeError(error, request.config));
        }
    }

    private finish(request: ActiveRequest, status: MessageStatus, error?: string) {
        if (this.active !== request) return;
        if (request.timer) clearTimeout(request.timer);
        request.timer = null;
        this.active = null;
        let saved = false;
        try {
            this.store.saveReply(request.sessionId, request.messageId, request.content, status, error);
            saved = true;
        } catch (failure) { this.storageFailed(failure); }
        // On write failure, keep the latest text visible, but never label it a saved/completed reply.
        this.updateReply(request, saved ? status : "interrupted", error);
        this.publish({ status: "idle" });
    }

    stop = () => {
        if (!this.active) return;
        const request = this.active;
        request.abort.abort();
        this.finish(request, "interrupted");
    };

    reset = (): boolean => {
        if (this.disposed || this.snapshot.storageError) return false;
        this.stop();
        if (this.snapshot.storageError) return false;
        try {
            const session = this.store.create(this.workspace, { provider: this.config.provider, model: this.config.model });
            this.store.release(this.snapshot.session.id);
            this.publish({ session, messages: [], status: "idle", contextState: emptyContextState(), lastContext: null, contextError: null });
            return true;
        } catch (error) { this.storageFailed(error); return false; }
    };

    listSessions = () => this.store.list(this.workspace);

    rename = (title: string) => {
        this.assertContextEditable();
        const saved = this.store.rename(this.snapshot.session.id, title);
        this.publish({ session: { ...this.snapshot.session, title: saved } });
    };

    exportSession = (path: string) => {
        this.assertContextEditable();
        writeSessionExport(path, this.store.exportSession(this.snapshot.session.id, this.workspace));
    };

    importSession = (path: string) => {
        this.assertContextEditable();
        const session = this.store.importSession(readSessionExport(path), this.workspace, this.config);
        try { this.resume(session.id); }
        catch (error) { this.store.release(session.id); throw error; }
    };

    switchModel = (config: AppConfig, options: { stopActive?: boolean; sessionId?: string } = {}) => {
        if (this.disposed || this.snapshot.storageError) throw new Error("Resolve the session storage problem before changing models.");
        if (options.sessionId && options.sessionId !== this.snapshot.session.id) throw new Error("The conversation changed while checking the provider. Open the model picker again.");
        checkModelId(config.model);
        if (!["openrouter", "ollama"].includes(config.provider)) throw new Error("Choose OpenRouter or Ollama.");
        const problem = getConfigProblem(config, {});
        if (problem) throw new Error(problem);
        const nextModel = this.modelFactory(config);
        if (this.active && !options.stopActive) throw new Error("A reply is running. Stop it before switching models.");
        this.stop();
        if (this.snapshot.storageError) throw new Error("The partial reply could not be saved; the model was not changed.");
        try { this.store.setSelection(this.snapshot.session.id, { provider: config.provider, model: config.model }); }
        catch (error) { this.storageFailed(error); throw error; }
        this.model = nextModel;
        this.configProblem = null;
        this.publish({ config: { ...config }, contextError: null, session: { ...this.snapshot.session, selection: { provider: config.provider, model: config.model } } });
    };

    resume = (id: string) => {
        if (this.disposed || this.snapshot.storageError) return;
        if (id === this.snapshot.session.id) return;
        // Check availability before interrupting the current request.
        const session = this.store.acquire(id, this.workspace);
        let config: AppConfig;
        let model: LanguageModel;
        let messages: SessionMessage[];
        let contextState: ContextState;
        let lastContext: ContextRecord | null;
        try {
            config = session.selection ? this.resolveConfig(session.selection) : this.config;
            model = this.modelFactory(config);
            messages = this.store.messages(id);
            contextState = this.store.contextState(id);
            lastContext = this.store.latestContextRecord(id);
        }
        catch (error) { this.store.release(id); throw error; }
        this.stop();
        if (this.snapshot.storageError) { this.store.release(id); return; }
        this.store.release(this.snapshot.session.id);
        this.model = model;
        this.configProblem = getConfigProblem(config, {});
        this.publish({ config, session, messages, status: "idle", contextState, lastContext, contextError: null });
    };

    prepareContext = (messages = this.snapshot.messages, state = this.snapshot.contextState): ContextPlan =>
        buildContext({ config: this.config, messages, state, system: SYSTEM_PROMPT });

    previewContext = (state = this.snapshot.contextState): ContextPlan =>
        buildContext({ config: this.config, messages: this.snapshot.messages, state, system: SYSTEM_PROMPT, protectLatestTurn: false });

    private recordContext(plan: ContextPlan, messageId?: string, state?: ContextState) {
        const record: ContextRecord = { ...plan.report, provider: this.config.provider, model: this.config.model,
            id: crypto.randomUUID(), createdAt: Date.now(), messageId };
        this.store.saveContextRecord(this.snapshot.session.id, record, state);
        this.publish({ lastContext: record, ...(state ? { contextState: state, contextError: null } : {}) });
    }

    private assertContextEditable() {
        if (this.disposed || this.snapshot.storageError) throw new Error("Resolve the storage problem before changing context.");
        if (this.active) throw new Error("Stop the current reply before changing context or task notes.");
    }

    private updateContext(state: ContextState) {
        this.assertContextEditable();
        try { this.store.saveContextState(this.snapshot.session.id, state); }
        catch (error) { this.storageFailed(error); throw error; }
        this.publish({ contextState: state, contextError: null });
    }

    setNotes = (notes: string) => {
        if (notes.length > 16_000) throw new Error("Keep task notes under 16,000 characters; smaller models may require shorter notes.");
        this.updateContext({ ...this.snapshot.contextState, notes: notes.trim() });
    };

    setContextLimits = (limits?: ContextOverride) => {
        const overrides = { ...this.snapshot.contextState.overrides };
        if (limits) overrides[selectionKey(this.config)] = validateOverride(limits);
        else delete overrides[selectionKey(this.config)];
        this.updateContext({ ...this.snapshot.contextState, overrides });
    };

    restoreFullContext = () => this.updateContext({ ...this.snapshot.contextState, forceCompact: false });

    compact = () => {
        this.assertContextEditable();
        const state = { ...this.snapshot.contextState, forceCompact: true };
        const plan = this.previewContext(state);
        try { this.recordContext(plan, undefined, state); }
        catch (error) { this.storageFailed(error); throw error; }
        return plan.report;
    };

    /** Synchronous flushing also works from process exit / renderer destroy handlers. */
    dispose = () => {
        if (this.disposed) return;
        this.stop();
        this.disposed = true;
        this.listeners.clear();
        this.store.close();
    };
}
