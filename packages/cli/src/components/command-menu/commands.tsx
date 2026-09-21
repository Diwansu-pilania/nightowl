import { Command } from "./types";
export const COMMANDS: Command[] =[
    {
        name:"new",
        description:"Start a new conversation",
        value:"/new",
    },{
        name:"agents",
        description: "Switch between agents",
        value:"/agents",
    },{
        name:"models",
        description:"Switch between models",
        value:"/models",
    },{
        name:"sessions",
        description:"Browse past sessions",
        value:"/sessions",  
    },{
        name:"theme",
        description:"Change color theme",
        value:"/theme",
    },{
        name:"login",
        description:"Login through browser",
        value:"/login",
    },{
        name :"logout",
        description:"Logout from the application",
        value:"/logout",
    },{
        name:"upgrade",
        description:"Upgrade to pro",
        value:"/upgrade",
    },{
        name:"usage",
        description:"View usage statistics",
        value:"/usage",
    },{
        name:"exit",
        description:"Exit the application",
        value:"/exit",
        action:(ctx)=>{
            ctx.exit();
        },
    },
];