import type { ToastContextValue } from "../../providers/toast";
import type { ChatContextValue } from "../../providers/chat";

export type CommandContext ={
    exit:()=>void;
    toast:ToastContextValue;
    chat:ChatContextValue;
};

export type Command ={
    name:string;
    description:string;
    value:string;
    action?:(ctx:CommandContext)=>void | Promise<void>;
};
