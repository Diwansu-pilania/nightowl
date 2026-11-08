import type { RefObject } from "react";
import {TextAttributes, type ScrollBoxRenderable} from "@opentui/core";
import { getFilteredCommands } from "./filter-commands";
import {COMMANDS} from "./commands";

const MAX_VISIBLE_COMMANDS = 7; // Maximum number of commands to display at once 
const COMMAND_COL_WIDTH= Math.max(...COMMANDS.map((cmd)=>cmd.name.length)) + 4; // Calculate the maximum command name length and add padding

type CommandMenuProps = {
    query: string;
    selectedIndex: number;
    onSelect: (index: number) => void;
    onExecute: (index: number) => void;
    scrollBoxRef: RefObject<ScrollBoxRenderable | null>;
};

export function CommandMenu({
    query,
    selectedIndex,
    onSelect,
    onExecute,
    scrollBoxRef,
}: CommandMenuProps) {
    const filtered = getFilteredCommands(query);
    const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_COMMANDS);

    if(filtered.length === 0) {
        return (
            <box height={1} paddingX={1}>
                <text selectable={false} attributes={TextAttributes.DIM} fg="gray">
                    No commands found
                </text>
            </box>
        );
    }

    return (
        <scrollbox ref={scrollBoxRef} height={visibleHeight}>
            {filtered.map((cmd, index) => {
                const isSelected = index ===selectedIndex;

                return (
                    <box
                        key={cmd.value}
                        flexDirection="row"
                        paddingX={1}
                        height={1}
                        overflow="hidden"
                        backgroundColor={isSelected ? "blue" : undefined}
                        onMouseMove={() => onSelect(index)}
                        onMouseDown={() => onExecute(index)}

                    >   
                    <box width ={COMMAND_COL_WIDTH} flexShrink={0}>
                        <text selectable={false} fg={isSelected ? "black":"white"}>
                            /{cmd.name}
                        </text>
                    </box>
                    <box flexGrow={1} flexShrink={1} overflow="hidden">
                        <text selectable={false} fg={isSelected ? "black":"gray"}>
                            {cmd.description}
                        </text>
                    </box>
                    </box>
                );
            } )}
        </scrollbox>
    )
}