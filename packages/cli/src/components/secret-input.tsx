import { useEffect, useRef, useState } from "react";
import { useKeyboard, usePaste } from "@opentui/react";

/** The key never enters a renderable text buffer or chat input. */
export function SecretInput({ disabled, onSubmit }: { disabled: boolean; onSubmit: (key: string, remember: boolean) => void }) {
    const secret = useRef("");
    const [length, setLength] = useState(0);
    const [error, setError] = useState("");
    const update = (value: string) => {
        if (value.length > 512 || /[^\x21-\x7e]/.test(value)) { setError("Use a key without whitespace, up to 512 characters."); return; }
        secret.current = value;
        setLength(value.length);
        setError("");
    };
    useEffect(() => () => { secret.current = ""; }, []);
    usePaste((event) => {
        event.preventDefault();
        if (!disabled) update(secret.current + new TextDecoder().decode(event.bytes).trim());
    });
    useKeyboard((key) => {
        if (disabled || key.name === "escape" || (key.ctrl && key.name === "c")) return;
        key.preventDefault();
        if (key.name === "return" || key.name === "enter") onSubmit(secret.current, false);
        else if (key.ctrl && key.name === "s") onSubmit(secret.current, true);
        else if (key.ctrl && key.name === "u") update("");
        else if (key.name === "backspace") update(secret.current.slice(0, -1));
        else if (!key.ctrl && !key.meta && !key.option && /^[\x21-\x7e]+$/.test(key.sequence)) update(secret.current + key.sequence);
    });
    return (
        <box>
            <text>{length ? `${"•".repeat(Math.min(length, 48))} (${length} characters)` : "Paste or type your OpenRouter API key (hidden)"}</text>
            {error && <text fg="#F44336">{error}</text>}
            <text fg="gray">Enter: use for this run · Ctrl+S: save locally and use · Ctrl+U: clear</text>
            <text fg="gray" wrapMode="word">Saving stores an unencrypted key in your NightOwl credentials file.</text>
        </box>
    );
}
