import type { KeyBinding } from "@opentui/core";
import { StatusBar } from "./status-bar";
import { CommandMenu } from "./command-menu";
import {useRef,useCallback,useEffect} from "react";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useCommandMenu } from "./command-menu/use-command-menu";
import type { Command } from "./command-menu/types";
import { COMMANDS } from "./command-menu/commands";
import {useToast} from "../providers/toast";
import { useChat } from "../providers/chat";

type Props={
    disabled?: boolean;
};

export const TEXTAREA_KEY_BINDINGS: KeyBinding[]=[
    {name : "return",action:"submit"},
    {name : "enter",action:"submit"},
    {name: "return",shift:true , action: "newline"},
    {name : "enter",shift:true , action: "newline"},
]

export function InputBar({disabled}:Props){
    const textareaRef=useRef<TextareaRenderable | null>(null);
    const onSubmitRef= useRef<()=>void>(()=>{});
    const renderer= useRenderer();
    const toast= useToast();
    const chat= useChat();
    const {
        showCommandMenu,
        commandQuery,
        selectedIndex,
        scrollRef,
        handleContentChange,
        resolveCommand,
        setSelectedIndex,
    }= useCommandMenu();

    const handelTextareaContentChange= useCallback(()=>{
        const textarea = textareaRef.current;
        if(!textarea)return;
        const text = textarea.plainText;
        handleContentChange(text);
    },[]);

    const handleSubmit= useCallback(()=>{
        if(disabled)return;
        const textarea = textareaRef.current;
        if(!textarea)return;
        const text = textarea.plainText.trim();
        if(text.length ===0)return;
        // send() refuses while a reply is still streaming; keep the user's
        // text in the box instead of throwing it away.
        if(!chat.send(text)){
            if(chat.status === "streaming") toast.show({message:"NightOwl is still replying. Press Esc to stop it."});
            return;
        }
        textarea.setText("");
    },[disabled,chat.send,chat.status,toast]);

    const handleCommand= useCallback((
        command: Command | undefined
    )=>{
        const textarea = textareaRef.current;
        if(!textarea || !command)return;
        textarea.setText("");
        if(command.action){
            command.action({
                exit:()=>renderer.destroy(),
                toast,
                chat,
            });
        }else{
            textarea.insertText(command.value + " ");
        }
    },[renderer,toast,chat]);

    // Esc stops a streaming reply. When the command menu is open, Esc belongs
    // to the menu (it closes it), so we leave it alone. OpenTUI runs every
    // useKeyboard listener for each key, so this check is what prevents one
    // Esc press from doing both things.
    useKeyboard((key)=>{
        // The renderer is created with exitOnCtrlC:false, so quitting is our job.
        if(key.ctrl && key.name === "c"){
            renderer.destroy();
            return;
        }
        if(disabled)return;
        if(key.name !== "escape" || showCommandMenu)return;
        if(chat.status === "streaming"){
            chat.stop();
        }
    });

    // Must depend on resolveCommand: it closes over the *filtered* list,
    // so an empty deps array would always resolve against the full list.
    const handleCommandExecute= useCallback((index: number)=>{
        const command = resolveCommand(index);
        handleCommand(command);
    },[resolveCommand,handleCommand]);

    useEffect(()=>{
        const textarea = textareaRef.current;
        if(!textarea)return;
        textarea.onSubmit=()=>{
            onSubmitRef.current();
        };
    },[]);

    onSubmitRef.current=()=>{
        if(disabled)return;
        // A pasted command + Enter can arrive before React renders the menu.
        const exactCommand = COMMANDS.find((command) => command.value === textareaRef.current?.plainText.trim());
        if(exactCommand){
            handleCommand(exactCommand);
            return;
        }
        if(showCommandMenu){
            const command = resolveCommand(selectedIndex);
            handleCommand(command);
            return;
        }
        handleSubmit();
    };

    return (
        <box width="100%" alignItems="center">
            <box
                width="100%"
                border={["left","right"]}
                borderColor="brightcyan">
                <box
                    position="relative"
                    justifyContent="center"
                    paddingX={2}
                    paddingY={1}
                    backgroundColor="black"
                    width="100%"
                    gap={1}
                >
                    {showCommandMenu && (
                        <box
                            position="absolute"
                            bottom="100%"
                            left={0}
                            width="100%"
                            backgroundColor="#1A1A24"
                            zIndex={10}
                        >
                            <CommandMenu
                                query={commandQuery}
                                selectedIndex={selectedIndex}
                                onSelect={setSelectedIndex}
                                onExecute={handleCommandExecute}
                                scrollBoxRef={scrollRef}
                            />
                        </box>
                    )}
                    <textarea 
                        ref={textareaRef}
                        maxHeight={8}
                        focused={!disabled}
                        keyBindings={TEXTAREA_KEY_BINDINGS}
                        onContentChange={handelTextareaContentChange}
                        placeholder="Ask anything...  (type / for commands)"
                    />
                    <StatusBar/>
                </box>
            </box>
        </box>
    );
};
