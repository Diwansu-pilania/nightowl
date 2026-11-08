import type { Command } from "./types";
export const COMMANDS: Command[] =[
    {
        name:"new",
        description:"Start a new conversation",
        value:"/new",
        action:(ctx)=>{
            ctx.toast.show({message:"Starting a new conversation"}); 
        }
    },{
        name:"agents",
        description: "Switch between agents",
        value:"/agents",
        action:(ctx)=>{
            ctx.toast.show({message:"Changing agent.."}); 
        }
    },{
        name:"models",
        description:"Switch between models",
        value:"/models",
        action:(ctx)=>{
            ctx.toast.show({message:"Select the model ...."}); 
        }
    },{
        name:"sessions",
        description:"Browse past sessions",
        value:"/sessions",  
        action:(ctx)=>{
            ctx.toast.show({message:"Choose the session you want...."}); 
        }
    },{
        name:"theme",
        description:"Change color theme",
        value:"/theme",
        action:(ctx)=>{
            ctx.toast.show({message:"Choosing the theme you want...."}); 
        }
    },{
        name:"login",
        description:"Login through browser",
        value:"/login",
        action:(ctx)=>{
            ctx.toast.show({message:"Login through browser...."}); 
        }
    },{
        name :"logout",
        description:"Logout from the application",
        value:"/logout",
        action:(ctx)=>{
            ctx.toast.show({message:"Logging out from the application...."}); 
        }
    },{
        name:"upgrade",
        description:"Upgrade to pro",
        value:"/upgrade",
        action:(ctx)=>{
            ctx.toast.show({message:"Upgrading the plan..."}); 
        }
    },{
        name:"usage",
        description:"View usage statistics",
        value:"/usage",
        action:(ctx)=>{
            ctx.toast.show({message:"Showing usage statistics..."}); 
        }
    },{
        name:"exit",
        description:"Exit the application",
        value:"/exit",
        action:(ctx)=>{
            ctx.exit();
        },
    },
];