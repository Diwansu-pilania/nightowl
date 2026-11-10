import { useMemo } from "react";
import { TextAttributes } from "@opentui/core";
import { marked, type Token, type Tokens } from "marked";

// Basic Markdown without network-loaded parsers, syntax workers, HTML execution,
// or image fetching. Source text remains unchanged in the saved transcript.
function inline(text: string): string {
    return marked.lexer(text, { gfm: true }).map((token) => flatten(token)).join("");
}
function flatten(token: Token): string {
    if (token.type === "link") return token.text === token.href ? token.text : `${token.text} (${token.href})`;
    if (token.type === "image") return `[Image: ${token.text}] (${token.href})`;
    if ("tokens" in token && Array.isArray(token.tokens)) return token.tokens.map(flatten).join("");
    if (token.type === "br") return "\n";
    return "text" in token && typeof token.text === "string" ? token.text : token.raw;
}

export function AssistantText({ content }: { content: string }) {
    const tokens = useMemo(() => marked.lexer(content, { gfm: true }), [content]);
    return <box gap={1}>
        {tokens.filter((token) => token.type !== "space").map((token, index) => {
            if (token.type === "code") return <box key={index} backgroundColor="#1A1A24" paddingX={1}>
                {token.lang && <text fg="gray">{token.lang}</text>}
                <text fg="#E1E1E1" wrapMode="word">{token.text}</text>
            </box>;
            if (token.type === "heading") return <text key={index} fg="brightcyan" attributes={TextAttributes.BOLD} wrapMode="word">{flatten(token)}</text>;
            if (token.type === "list") return <box key={index}>
                {token.items.map((item: Tokens.ListItem, i: number) => <text key={i} fg="#E1E1E1" wrapMode="word">{`${token.ordered ? `${Number(token.start) + i}.` : "•"} ${item.task ? item.checked ? "[x] " : "[ ] " : ""}${inline(item.text)}`}</text>)}
            </box>;
            if (token.type === "table") return <box key={index}>
                <text attributes={TextAttributes.BOLD} wrapMode="word">{token.header.map((cell: Tokens.TableCell) => inline(cell.text)).join(" | ")}</text>
                {token.rows.map((row: Tokens.TableCell[], i: number) => <text key={i} wrapMode="word">{row.map((cell: Tokens.TableCell) => inline(cell.text)).join(" | ")}</text>)}
            </box>;
            if (token.type === "hr") return <text key={index} fg="gray">────────────────────</text>;
            return <text key={index} fg="#E1E1E1" wrapMode="word">{flatten(token)}</text>;
        })}
    </box>;
}
