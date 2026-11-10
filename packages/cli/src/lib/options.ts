export type CliOptions = { help: boolean; version: boolean; list: boolean; startNew: boolean; setup: boolean; sessionId?: string; exportPath?: string; importPath?: string; title?: string };

export function parseOptions(args: string[]): CliOptions {
    const options: CliOptions = { help: false, version: false, list: false, startNew: false, setup: false };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") continue;
        if (arg === "--help" || arg === "-h") options.help = true;
        else if (arg === "--version" || arg === "-v") options.version = true;
        else if (arg === "--sessions") options.list = true;
        else if (arg === "--new") options.startNew = true;
        else if (arg === "--setup") options.setup = true;
        else if (arg === "--resume" || arg === "--export" || arg === "--import" || arg === "--rename") {
            const value = args[i + 1];
            if (!value || value.startsWith("--")) throw new Error(arg === "--resume" ? "--resume needs a session ID from --sessions." : `${arg} needs a value. Use --help.`);
            if (arg === "--resume") options.sessionId = value;
            else if (arg === "--export") options.exportPath = value;
            else if (arg === "--import") options.importPath = value;
            else options.title = value;
            i++;
        } else throw new Error(`Unknown option: ${arg}. Use --help.`);
    }
    if (options.startNew && options.sessionId) throw new Error("Choose either --new or --resume, not both.");
    const operations = [options.exportPath, options.importPath, options.title].filter((v) => v !== undefined);
    if (operations.length > 1 || (operations.length && (options.list || options.startNew || options.setup)) || (options.importPath && options.sessionId)) {
        throw new Error("Choose one import/export/rename operation; --resume can select a session for export or rename.");
    }
    return options;
}

export const HELP = `NightOwl — local terminal AI assistant

Usage: nightowl [--new | --resume <session-id>] [--sessions]

By default, resume the last opened conversation in the current workspace.
  --new             Start a new conversation (older chats are kept)
  --resume <id>     Resume a saved conversation in this workspace
  --sessions        List saved conversations without starting the interface
  --setup           Open provider/model setup
  --export <path>   Export this workspace's last session (or --resume <id>) to a new JSON file
  --import <path>   Import a JSON transcript into this workspace, without starting a model
  --rename <title>  Rename this workspace's last session (or --resume <id>)
  --help, -h        Show this help
  --version, -v     Show the version

In chat: /models changes provider/model, /sessions opens saved conversations,
/context inspects budgets, /compact reduces older context, /memory edits task notes.
/rename, /export and /import manage portable conversations.
Esc stops a reply, Ctrl+C or /exit saves and quits.

Providers: set OPENROUTER_API_KEY, or use a local Ollama model.
Optional: NIGHTOWL_PROVIDER, NIGHTOWL_MODEL, OLLAMA_BASE_URL, NIGHTOWL_DATA_DIR.
Selections are saved per conversation; explicit environment selections override on launch.
`;
