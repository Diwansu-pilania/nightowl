import type { KeyBinding } from "@opentui/core";
import { StatusBar } from "./status-bar";
import { CommandMenu } from "./command-menu";
import {useRef,useCallback,useEffect} from "react";
import type { TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useCommandMenu } from "./command-menu/use-command-menu";
import type { Command } from "./command-menu/types";   
import {useToast} from "../providers/toast";

type Props={
    onSubmit: (value:string)=>void;
    disabled?: boolean;
};

export const TEXTAREA_KEY_BINDINGS: KeyBinding[]=[
    {name : "return",action:"submit"},
    {name : "enter",action:"submit"},
    {name: "return",shift:true , action: "newline"},
    {name : "enter",shift:true , action: "newline"},
]

export function InputBar({onSubmit,disabled}:Props){
    const textareaRef=useRef<TextareaRenderable | null>(null);
    const onSubmitRef= useRef<()=>void>(()=>{});
    const renderer= useRenderer();
    const toast= useToast();
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
        onSubmit(text);
        textarea.setText("");
    },[disabled,onSubmit]);

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
            });
        }else{
            textarea.insertText(command.value + " ");
        }
    },[renderer,toast]);

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
                        focused={!disabled}
                        keyBindings={TEXTAREA_KEY_BINDINGS}
                        onContentChange={handelTextareaContentChange}
                        placeholder="Type your command here..."
                    />
                    <StatusBar/>
                </box>
            </box>
        </box>
    );
};