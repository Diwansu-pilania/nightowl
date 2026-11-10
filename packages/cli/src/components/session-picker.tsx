import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { Session } from "@nightowl/core";
import { useChat } from "../providers/chat";

export function SessionPicker({ sessions }: { sessions: Session[] }) {
    const chat = useChat();
    const [selected, setSelected] = useState(0);
    const pageSize = 6;
    const pageStart = Math.floor(selected / pageSize) * pageSize;
    useKeyboard((key) => {
        if (key.name === "escape") { key.preventDefault(); chat.closeSessions(); }
        if (key.name === "up") { key.preventDefault(); setSelected((i) => Math.max(0, i - 1)); }
        if (key.name === "down") { key.preventDefault(); setSelected((i) => Math.min(sessions.length - 1, i + 1)); }
        if (key.name === "return" || key.name === "enter") {
            key.preventDefault();
            if (sessions[selected]) chat.resume(sessions[selected].id);
        }
    });
    return (
        <box position="absolute" top={2} width="90%" maxWidth={74} backgroundColor="#1A1A24" border padding={1} zIndex={20}>
            <text>Saved conversations — Enter to resume, Esc to close</text>
            <text fg="gray">Switching saves and stops any reply in progress.</text>
            {sessions.slice(pageStart, pageStart + pageSize).map((session, offset) => (
                <box
                    key={session.id} height={2} paddingX={1}
                    backgroundColor={selected === pageStart + offset ? "blue" : undefined}
                    onMouseMove={() => setSelected(pageStart + offset)}
                    onMouseDown={() => chat.resume(session.id)}
                >
                    <text wrapMode="none">{session.id === chat.session.id ? "• " : "  "}{session.title}</text>
                    <text fg="gray">{session.id.slice(0, 8)} · {new Date(session.updatedAt).toLocaleString()}</text>
                </box>
            ))}
            <text fg="gray">{selected + 1} / {sessions.length} · ↑/↓ to select</text>
        </box>
    );
}
