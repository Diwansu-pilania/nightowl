import {TextAttributes} from "@opentui/core";

export function StatusBar(){
    return (
        <box flexDirection="row" gap={1 } width={80} height={1}>
            <text fg="cyan Bright">Build</text>
            <text attributes={TextAttributes.DIM} fg="gray"> &#8250; </text>
            <text>opus-4-6</text>
        </box>
    );
};