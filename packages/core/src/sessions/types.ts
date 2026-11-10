import type { ProviderId } from "../config";

/** Provider-independent text history. No SDK objects or credentials are stored. */
export type ChatMessage = {
    id: string;
    role: "user" | "assistant";
    content: string;
    error?: string;
    interrupted?: boolean;
};

export type MessageStatus = "streaming" | "completed" | "interrupted" | "failed";
export type ModelSelection = { provider: ProviderId; model: string };

export type SessionMessage = ChatMessage & {
    sessionId: string;
    turnId: string;
    createdAt: number;
    status: MessageStatus;
    provider?: ProviderId;
    model?: string;
};

export type Session = {
    id: string;
    workspace: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    selection?: ModelSelection;
};

export type ModelSwitch = {
    id: string; sessionId: string; fromProvider: string | null; fromModel: string | null;
    toProvider: ProviderId; toModel: string; createdAt: number;
};

export type Attempt = ModelSelection & {
    id: string;
    sessionId: string;
    messageId: string;
    status: MessageStatus;
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
};

export type StartedTurn = {
    user: SessionMessage;
    assistant: SessionMessage;
    attemptId: string;
};
