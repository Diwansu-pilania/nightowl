import type { ProviderRegistry, SessionController } from "@nightowl/core";
import { Header } from "./components/header";
import { InputBar } from "./components/input-bar";
import { MessageList } from "./components/message-list";
import { SessionPicker } from "./components/session-picker";
import { ModelPicker } from "./components/model-picker";
import { ContextPanel } from "./components/context-panel";
import { SessionActionPanel } from "./components/session-action-panel";
import { ChatProvider, useChat } from "./providers/chat";
import { ToastProvider } from "./providers/toast";

/**
 * Two layouts:
 *  - home: logo + input centred on screen (no messages yet)
 *  - conversation: messages fill the screen, input pinned to the bottom
 *
 * The <InputBar> sits in the same position in the tree in both layouts, so
 * React keeps the same instance when we switch — the textarea doesn't
 * remount and keeps its focus.
 */
export function App() {
    const { messages, sessionChoices, storageError, showModels, contextPanel, contextError, lastContext, sessionAction } = useChat();
    const inConversation = messages.length > 0;

    return (
        <box
            alignItems="center"
            justifyContent={inConversation ? "flex-end" : "center"}
            backgroundColor="#0D0D12"
            width="100%"
            height="100%"
            gap={inConversation ? 1 : 2}
            paddingBottom={inConversation ? 1 : 0}
        >
            {inConversation ? <MessageList /> : <Header />}
            {storageError && <text flexShrink={0} fg="#F44336" wrapMode="word">{storageError}</text>}
            {contextError && <text flexShrink={0} fg="#F44336" wrapMode="word">{contextError}</text>}
            {lastContext?.compacted && <text flexShrink={0} fg="gray" wrapMode="word">Older context reduced locally · originals saved · /context to inspect</text>}
            <box width="100%" paddingX={2} flexShrink={0}>
                <InputBar disabled={sessionChoices !== null || showModels || contextPanel !== null || sessionAction !== null} />
            </box>
            {sessionChoices !== null && <SessionPicker sessions={sessionChoices} />}
            {showModels && <ModelPicker />}
            {contextPanel !== null && <ContextPanel initialPage={contextPanel} />}
            {sessionAction !== null && <SessionActionPanel action={sessionAction} />}
        </box>
    );
}

type RootProps = {
    controller: SessionController;
    providers?: ProviderRegistry;
    initialSetup?: boolean;
};

/** App + all of its context providers. */
export function Root({ controller, providers, initialSetup }: RootProps) {
    return (
        <ToastProvider>
            <ChatProvider controller={controller} providers={providers} initialSetup={initialSetup}>
                <App />
            </ChatProvider>
        </ToastProvider>
    );
}
