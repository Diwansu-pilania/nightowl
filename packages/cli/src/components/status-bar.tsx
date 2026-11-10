import {TextAttributes} from "@opentui/core";
import { useChat } from "../providers/chat";

export function StatusBar(){
    const { config, status, session } = useChat();

    return (
        <box flexDirection="row" justifyContent="space-between" width="100%" height={1}>
            <box flexDirection="row" gap={1}>
                <text fg="brightcyan">Chat</text>
                <text attributes={TextAttributes.DIM} fg="gray"> &#8250; </text>
                <text>{config.model}</text>
                <text attributes={TextAttributes.DIM} fg="gray">{config.provider}</text>
            </box>
            {status === "streaming" && (
                <text attributes={TextAttributes.DIM} fg="gray">esc to stop</text>
            )}
            {status === "idle" && <text attributes={TextAttributes.DIM} fg="gray">{session.id.slice(0, 8)}</text>}
        </box>
    );
};
