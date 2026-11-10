import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { ProviderRegistry, SessionController, type Session, type SessionSnapshot } from "@nightowl/core";
import { useToast } from "../toast";

type ChatContextValue = SessionSnapshot & {
    config: SessionController["config"];
    send: SessionController["send"];
    stop: SessionController["stop"];
    reset: SessionController["reset"];
    sessionChoices: Session[] | null;
    openSessions: () => void;
    closeSessions: () => void;
    resume: (id: string) => void;
    registry: ProviderRegistry;
    showModels: boolean;
    openModels: () => void;
    closeModels: () => void;
    switchModel: SessionController["switchModel"];
    contextPanel: "context" | "memory" | null;
    openContext: (page?: "context" | "memory") => void;
    closeContext: () => void;
    previewContext: SessionController["previewContext"];
    setNotes: SessionController["setNotes"];
    setContextLimits: SessionController["setContextLimits"];
    compact: SessionController["compact"];
    restoreFullContext: SessionController["restoreFullContext"];
    sessionAction: "rename" | "export" | "import" | null;
    openSessionAction: (action: "rename" | "export" | "import") => void;
    closeSessionAction: () => void;
    rename: SessionController["rename"];
    exportSession: SessionController["exportSession"];
    importSession: SessionController["importSession"];
};
export type { ChatContextValue };

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
    const value = useContext(ChatContext);
    if (!value) throw new Error("useChat must be used within a ChatProvider");
    return value;
}

/** React observes core state; the entry point owns the controller's lifetime. */
export function ChatProvider({ children, controller, providers, initialSetup = false }: {
    children: ReactNode; controller: SessionController; providers?: ProviderRegistry; initialSetup?: boolean;
}) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const [sessionChoices, setSessionChoices] = useState<Session[] | null>(null);
    const [showModels, setShowModels] = useState(initialSetup);
    const [contextPanel, setContextPanel] = useState<"context" | "memory" | null>(null);
    const [sessionAction, setSessionAction] = useState<"rename" | "export" | "import" | null>(null);
    const registry = useMemo(() => providers ?? new ProviderRegistry({ env: {} }), [providers]);
    const toast = useToast();
    const value = useMemo<ChatContextValue>(() => ({
        ...snapshot,
        config: controller.config,
        send: controller.send,
        stop: controller.stop,
        reset: controller.reset,
        registry,
        showModels,
        openModels: () => { setSessionChoices(null); setContextPanel(null); setSessionAction(null); setShowModels(true); },
        closeModels: () => setShowModels(false),
        switchModel: controller.switchModel,
        contextPanel,
        openContext: (page = "context") => { setContextPanel(page); setShowModels(false); setSessionChoices(null); setSessionAction(null); },
        closeContext: () => setContextPanel(null),
        previewContext: controller.previewContext,
        setNotes: controller.setNotes,
        setContextLimits: controller.setContextLimits,
        compact: controller.compact,
        restoreFullContext: controller.restoreFullContext,
        sessionAction,
        openSessionAction: (action) => { setSessionAction(action); setContextPanel(null); setShowModels(false); setSessionChoices(null); },
        closeSessionAction: () => setSessionAction(null),
        rename: controller.rename,
        exportSession: controller.exportSession,
        importSession: controller.importSession,
        sessionChoices,
        openSessions: () => {
            try { setSessionChoices(controller.listSessions()); setShowModels(false); setContextPanel(null); setSessionAction(null); }
            catch (error) { toast.show({ message: String(error), variant: "error" }); }
        },
        closeSessions: () => setSessionChoices(null),
        resume: (id) => {
            try {
                controller.resume(id);
                setSessionChoices(null);
            } catch (error) { toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" }); }
        },
    }), [snapshot, controller, sessionChoices, toast, registry, showModels, contextPanel, sessionAction]);
    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
