import { useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { InputRenderable } from "@opentui/core";
import { resolve } from "node:path";
import { useChat } from "../providers/chat";
import { useToast } from "../providers/toast";

export function SessionActionPanel({ action }: { action: "rename" | "export" | "import" }) {
    const chat = useChat();
    const toast = useToast();
    const input = useRef<InputRenderable | null>(null);
    const [value, setValue] = useState(action === "rename" ? chat.session.title : action === "export" ? `nightowl-${chat.session.id.slice(0, 8)}.nightowl.json` : "");
    const [error, setError] = useState("");
    useKeyboard((key) => {
        if (key.name === "escape") { key.preventDefault(); chat.closeSessionAction(); }
        if (key.name === "return" || key.name === "enter") {
            key.preventDefault();
            try {
                const text = (input.current?.value ?? value).trim();
                if (!text) throw new Error("Enter a value first.");
                if (action === "rename") chat.rename(text);
                else if (action === "export") chat.exportSession(resolve(text));
                else chat.importSession(resolve(text));
                chat.closeSessionAction();
                toast.show({ message: action === "rename" ? "Conversation renamed." : action === "export" ? `Saved ${resolve(text)}` : "Imported into a new conversation. Your selected provider is unchanged.", variant: "success" });
            } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        }
    });
    return <box position="absolute" top={2} width="94%" maxWidth={90} border padding={1} backgroundColor="#1A1A24" zIndex={20}>
        <text>{action === "rename" ? "Rename conversation" : action === "export" ? "Export conversation" : "Import conversation"}</text>
        <text fg="gray" wrapMode="word">{action === "rename" ? "Title (up to 70 characters)" : action === "export"
            ? "New JSON file path. Contains chat text and task notes; existing files are never overwritten."
            : "Session JSON file path. Creates a new conversation here, with its notes. No model request starts automatically."}</text>
        <input ref={input} value={value} onInput={setValue} focused />
        {error && <text fg="#F44336" wrapMode="word">{error}</text>}
        <text fg="gray">Enter apply · Esc cancel</text>
    </box>;
}
