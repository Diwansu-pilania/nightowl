import { join } from "node:path";
import { ProviderRegistry, ProviderSettingsStore, SessionController, SessionStore, canonicalWorkspace, getDataDirectory, getConfigProblem, readSessionExport, writeSessionExport } from "@nightowl/core";
import { HELP, parseOptions } from "./lib/options";
import metadata from "../package.json";

async function main() {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) { console.log(HELP); return; }
    if (options.version) { console.log(`NightOwl ${metadata.version}`); return; }
    const workspace = canonicalWorkspace(process.cwd());
    const store = new SessionStore(join(getDataDirectory(), "sessions.sqlite"));
    let controller: SessionController | undefined;
    try {
        if (options.list) {
            const sessions = store.list(workspace);
            if (sessions.length === 0) console.log("No saved conversations in this workspace.");
            for (const session of sessions) console.log(`${session.id}\t${JSON.stringify(session.title)}`);
            return;
        }
        if (options.importPath) {
            const session = store.importSession(readSessionExport(options.importPath), workspace);
            console.log(`Imported ${session.id}. No model was called. Resume with --resume ${session.id}.`);
            return;
        }
        if (options.exportPath || options.title) {
            const id = options.sessionId ?? store.list(workspace)[0]?.id;
            if (!id) throw new Error("No saved conversation in this workspace. Start a chat first.");
            if (options.exportPath) {
                writeSessionExport(options.exportPath, store.exportSession(id, workspace));
                console.log(`Exported conversation to ${options.exportPath}. The file contains chat text and task notes.`);
            } else {
                store.acquire(id, workspace);
                store.rename(id, options.title!);
                console.log(`Renamed ${id}.`);
            }
            return;
        }
        const providers = new ProviderRegistry({ settings: new ProviderSettingsStore(getDataDirectory()) });
        const config = providers.initialConfig();
        controller = new SessionController({
            store, workspace, config, configProblem: getConfigProblem(config),
            sessionId: options.sessionId, startNew: options.startNew,
            resolveConfig: providers.configFor, preferConfig: providers.hasEnvironmentSelection,
        });
        // Help/list/version do not load the native terminal renderer.
        const [{ createCliRenderer }, { createRoot }, { Root }] = await Promise.all([
            import("@opentui/core"), import("@opentui/react"), import("./app"),
        ]);
        const renderer = await createCliRenderer({ targetFps: 60, exitOnCtrlC: false });
        const close = () => controller?.dispose();
        process.once("exit", close);
        process.once("SIGTERM", () => { renderer.destroy(); });
        renderer.once("destroy", () => {
            close();
            process.exit(0);
        });
        createRoot(renderer).render(<Root controller={controller} providers={providers}
            initialSetup={options.setup || !providers.hasConfiguration || !!getConfigProblem(controller.config)} />);
    } catch (error) {
        controller?.dispose();
        store.close();
        throw error;
    } finally {
        if (!controller) store.close();
    }
}

main().catch((error) => {
    console.error(`NightOwl: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
