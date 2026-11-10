import { useEffect, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { InputRenderable } from "@opentui/core";
import type { ModelInfo, ModelSelection, ProviderId } from "@nightowl/core";
import { useChat } from "../providers/chat";
import { useToast } from "../providers/toast";
import { SecretInput } from "./secret-input";

type Page = "providers" | "models" | "key" | "url" | "manual" | "confirm";
const providers: ProviderId[] = ["ollama", "openrouter"];

export function ModelPicker() {
    const chat = useChat();
    const toast = useToast();
    const { height } = useTerminalDimensions();
    const [page, setPage] = useState<Page>("providers");
    const [provider, setProvider] = useState<ProviderId>(chat.config.provider);
    const [providerIndex, setProviderIndex] = useState(providers.indexOf(chat.config.provider));
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(0);
    const [field, setField] = useState("");
    const [pending, setPending] = useState<ModelSelection | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const operation = useRef<AbortController | null>(null);
    const fieldInput = useRef<InputRenderable | null>(null);
    const searchInput = useRef<InputRenderable | null>(null);
    const sessionId = useRef(chat.session.id);
    const pageSize = Math.max(2, Math.min(6, Math.floor((height - 14) / 2)));
    const filtered = models.filter((model) => `${model.model} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
    const pageStart = Math.floor(selected / pageSize) * pageSize;

    useEffect(() => () => operation.current?.abort(), []);

    const run = async (action: (signal: AbortSignal) => Promise<void>) => {
        operation.current?.abort();
        const request = new AbortController();
        operation.current = request;
        setBusy(true); setError(null);
        try { await action(request.signal); }
        catch (failure) { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Provider request failed."); }
        finally { if (!request.signal.aborted) setBusy(false); }
    };

    const load = (next: ProviderId, refresh = false) => {
        setProvider(next); setQuery(""); setSelected(0); setError(null);
        if (next === "openrouter" && !chat.registry.apiKey) { setPage("key"); return; }
        setPage("models"); setModels([]);
        void run(async (signal) => {
            const list = await chat.registry.models(next, signal, refresh);
            if (!signal.aborted) setModels(list);
        });
    };

    const apply = (selection: ModelSelection, stopActive = false) => {
        void run(async (signal) => {
            const config = await chat.registry.validate(selection, signal);
            if (signal.aborted) return;
            chat.switchModel(config, { stopActive, sessionId: sessionId.current });
            let savedDefault = true;
            try { chat.registry.rememberSelection({ provider: config.provider, model: config.model }); }
            catch { savedDefault = false; }
            chat.closeModels();
            toast.show({
                message: savedDefault ? `Using ${config.model} on ${config.provider}. Continue with your next message.` : "Model switched for this session, but the default could not be saved.",
                variant: savedDefault ? "success" : "error",
            });
        });
    };
    const choose = (selection: ModelSelection) => {
        if (busy) return;
        if (chat.status === "streaming") { setPending(selection); setPage("confirm"); }
        else apply(selection);
    };
    const editConnection = () => {
        setError(null);
        if (provider === "openrouter") setPage("key");
        else { setField(chat.registry.ollamaBaseURL); setPage("url"); }
    };
    const submitField = () => {
        const value = fieldInput.current?.value ?? field;
        if (page === "manual") choose({ provider, model: value });
        else void run(async (signal) => {
            await chat.registry.configureOllama(value, signal);
            const list = await chat.registry.models("ollama", signal, true);
            if (!signal.aborted) { setModels(list); setQuery(""); setSelected(0); setPage("models"); }
        });
    };

    useKeyboard((key) => {
        if (key.name === "escape") {
            key.preventDefault(); operation.current?.abort(); setBusy(false); setError(null);
            if (page === "providers") chat.closeModels();
            else { setPage("providers"); setPending(null); }
            return;
        }
        if (busy) return;
        if (page === "providers") {
            if (key.name === "up" || key.name === "down") { key.preventDefault(); setProviderIndex((i) => 1 - i); }
            if (key.name === "return" || key.name === "enter") { key.preventDefault(); load(providers[providerIndex]!); }
        } else if (page === "models") {
            if (key.name === "return" || key.name === "enter") {
                // Keep dialog navigation in one handler rather than native input submission.
                key.preventDefault();
                const value = searchInput.current?.value ?? query;
                const matches = models.filter((model) => `${model.model} ${model.name}`.toLowerCase().includes(value.toLowerCase()));
                const model = matches[value === query ? selected : 0] ?? matches[0];
                if (model) choose(model);
            }
            if (key.name === "up") { key.preventDefault(); setSelected((i) => Math.max(0, i - 1)); }
            if (key.name === "down") { key.preventDefault(); setSelected((i) => Math.min(Math.max(0, filtered.length - 1), i + 1)); }
            if (key.ctrl && key.name === "r") { key.preventDefault(); load(provider, true); }
            if (key.ctrl && key.name === "e") { key.preventDefault(); editConnection(); }
            if (key.ctrl && key.name === "m") { key.preventDefault(); setField(""); setPage("manual"); setError(null); }
        } else if ((page === "url" || page === "manual") && (key.name === "enter" || key.name === "return")) {
            key.preventDefault(); submitField();
        } else if (page === "confirm" && (key.name === "enter" || key.name === "return")) {
            key.preventDefault(); if (pending) apply(pending, true);
        }
    });

    return (
        <box position="absolute" top={1} width="94%" maxWidth={78} border padding={1} backgroundColor="#1A1A24" zIndex={20}>
            <text>Models & providers</text>
            {page === "providers" && <box gap={1}>
                <text fg="gray">Choose where to run your next reply. Esc closes this picker.</text>
                {providers.map((id, index) => <box key={id} backgroundColor={providerIndex === index ? "blue" : undefined}
                    onMouseMove={() => setProviderIndex(index)} onMouseDown={() => load(id)}>
                    <text>{id === "ollama" ? "Ollama — models on your computer or chosen server" : "OpenRouter — cloud models using your API key"}</text>
                </box>)}
                <text fg="gray">↑/↓ to choose · Enter to connect</text>
            </box>}
            {page !== "providers" && <text fg="gray">{provider === "openrouter" ? `OpenRouter · key: ${chat.registry.credentialSource}` : "Ollama · installed models"}</text>}
            {page === "key" && <SecretInput disabled={busy} onSubmit={(key, remember) => {
                if (busy) return;
                void run(async (signal) => {
                    await chat.registry.configureKey(key, remember, signal);
                    const list = await chat.registry.models("openrouter", signal);
                    if (!signal.aborted) { setModels(list); setQuery(""); setSelected(0); setPage("models"); }
                });
            }} />}
            {(page === "url" || page === "manual") && <box>
                <text>{page === "url" ? "Ollama server URL" : "Model ID (provider availability is checked on use)"}</text>
                <input ref={fieldInput} key={page} value={field} onInput={setField} focused={!busy} />
                <text fg="gray">Enter to apply · Esc to go back</text>
            </box>}
            {page === "models" && <box>
                <input ref={searchInput} key={provider} placeholder="Search models..." focused={!busy} onInput={(value) => { setQuery(value); setSelected(0); }} />
                {filtered.slice(pageStart, pageStart + pageSize).map((model, offset) => <box key={model.model} height={2}
                    backgroundColor={selected === pageStart + offset ? "blue" : undefined}
                    onMouseMove={() => setSelected(pageStart + offset)} onMouseDown={() => choose(model)}>
                    <text wrapMode="none">{model.model}</text>
                    <text fg="gray" wrapMode="none">{model.contextLength ? `${model.contextLength.toLocaleString()} advertised context tokens` : "Context depends on model/server settings"}{model.tools === undefined ? "" : model.tools ? " · tools" : " · chat"}</text>
                </box>)}
                {!busy && filtered.length === 0 && <text>{models.length ? "No matching models. Try another search or enter an ID." : "No models listed. Install one in Ollama, retry, or enter a model ID."}</text>}
                <text fg="gray">{filtered.length} models · ↑/↓ select · Enter switch · Esc back</text>
                <text fg="gray">Ctrl+R refresh · Ctrl+E connection settings · Ctrl+M enter model ID</text>
            </box>}
            {page === "confirm" && <box>
                <text wrapMode="word">Stop the current reply and switch to {pending?.model}?</text>
                <text fg="gray">The partial answer will be saved. No new reply starts automatically.</text>
                <text>Enter: stop and switch · Esc: cancel</text>
            </box>}
            {page !== "providers" && <text fg="gray" wrapMode="word">{provider === "openrouter" ? "Your next message sends saved chat context to OpenRouter." : "Your next message uses your configured Ollama server."}</text>}
            {busy && <text fg="gray">Checking provider… Esc cancels</text>}
            {error && <text fg="#F44336" wrapMode="word">{error}</text>}
        </box>
    );
}
