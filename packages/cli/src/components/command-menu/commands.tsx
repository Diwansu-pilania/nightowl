import type { Command } from "./types";

// Only working alpha features are advertised in the menu.
export const COMMANDS: Command[] = [
    { name: "new", description: "Start a new conversation", value: "/new", action: (ctx) => {
        if (ctx.chat.reset()) ctx.toast.show({ message: "Started a new conversation", variant: "success" });
    } },
    { name: "models", description: "Switch provider or model", value: "/models", action: (ctx) => ctx.chat.openModels() },
    { name: "sessions", description: "Browse saved conversations", value: "/sessions", action: (ctx) => ctx.chat.openSessions() },
    { name: "rename", description: "Rename this conversation", value: "/rename", action: (ctx) => ctx.chat.openSessionAction("rename") },
    { name: "export", description: "Save a portable conversation JSON file", value: "/export", action: (ctx) => ctx.chat.openSessionAction("export") },
    { name: "import", description: "Import a conversation into this workspace", value: "/import", action: (ctx) => ctx.chat.openSessionAction("import") },
    { name: "context", description: "Inspect context and adjust token limits", value: "/context", action: (ctx) => ctx.chat.openContext() },
    { name: "memory", description: "Edit this conversation's task notes", value: "/memory", action: (ctx) => ctx.chat.openContext("memory") },
    { name: "compact", description: "Reduce older context locally; keep originals", value: "/compact", action: (ctx) => {
        try { ctx.chat.compact(); ctx.chat.openContext(); }
        catch (error) { ctx.toast.show({ message: error instanceof Error ? error.message : String(error), variant: "error" }); }
    } },
    { name: "exit", description: "Save and quit", value: "/exit", action: (ctx) => ctx.exit() },
];
