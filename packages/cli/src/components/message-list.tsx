import { TextAttributes } from "@opentui/core";
import { useChat } from "../providers/chat";
import type { SessionMessage } from "@nightowl/core";
import { AssistantText } from "./assistant-text";

/**
 * The scrollable conversation.
 *
 * `stickyScroll` + `stickyStart="bottom"` makes the scrollbox follow new
 * content as it streams in — unless the user scrolls up to read, in which
 * case it stays put until they scroll back to the bottom.
 */
export function MessageList() {
    const { messages, status } = useChat();
    const lastIndex = messages.length - 1;

    return (
        <scrollbox flexGrow={1} flexBasis={0} minHeight={0} width="100%" stickyScroll stickyStart="bottom">
            <box flexDirection="column" gap={1} paddingX={2} paddingTop={1}>
                {messages.map((message, index) => (
                    <MessageItem
                        key={message.id}
                        message={message}
                        isStreaming={status === "streaming" && index === lastIndex}
                    />
                ))}
            </box>
        </scrollbox>
    );
}

type MessageItemProps = {
    message: SessionMessage;
    isStreaming: boolean;
};

function MessageItem({ message, isStreaming }: MessageItemProps) {
    if (message.role === "user") {
        return (
            <box border={["left"]} borderColor="brightcyan" backgroundColor="#1A1A24" paddingX={1}>
                <text fg="#E1E1E1" wrapMode="word">{message.content}</text>
            </box>
        );
    }

    const waitingForFirstToken = isStreaming && message.content.length === 0;

    return (
        <box flexDirection="column" paddingLeft={2}>
            <text fg="gray" attributes={TextAttributes.DIM}>{message.model} · {message.provider}</text>
            {message.content.length > 0 && (
                <AssistantText content={message.content} />
            )}
            {waitingForFirstToken && (
                <text fg="gray" attributes={TextAttributes.DIM}>
                    Thinking...
                </text>
            )}
            {message.error && (
                <text fg="#F44336" wrapMode="word">
                    {`x ${message.error}`}
                </text>
            )}
            {message.interrupted && (
                <text fg="gray" attributes={TextAttributes.DIM}>
                    (stopped)
                </text>
            )}
        </box>
    );
}
