import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import metadata from "../package.json";

const prefix = join(tmpdir(), "nightowl-release-smoke-");
const directory = mkdtempSync(prefix);
const archive = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dir, `../dist/releases/nightowl-v${metadata.version}-windows-x64.zip`);
try {
    const expected = readFileSync(`${archive}.sha256`, "utf8").split(/\s/)[0];
    if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected) throw new Error("Archive checksum mismatch.");
    // Check Windows-compatible entry names and use a different ZIP reader from
    // the packager. Native Explorer/WinRAR extraction is also checked at release.
    const extraction = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-File",
        resolve(import.meta.dir, "extract-release.ps1"), "-ArchivePath", archive, "-DestinationPath", directory],
        { stdout: "inherit", stderr: "inherit" });
    if (extraction.exitCode !== 0) throw new Error("Windows release archive validation/extraction failed.");
    const binary = join(directory, "nightowl.exe");
    const env = { ...process.env, NIGHTOWL_DATA_DIR: join(directory, "data"), OPENROUTER_API_KEY: "", NIGHTOWL_PROVIDER: "", NIGHTOWL_MODEL: "", OLLAMA_BASE_URL: "" };
    // An arbitrary workspace cannot override the distributed launcher's config.
    writeFileSync(join(directory, ".env"), "NIGHTOWL_DATA_DIR=do-not-use\nNIGHTOWL_PROVIDER=untrusted\n");
    writeFileSync(join(directory, "bunfig.toml"), "this is deliberately invalid toml [");
    const run = (...args: string[]) => {
        const child = Bun.spawnSync([binary, ...args], { cwd: directory, env });
        if (child.exitCode !== 0) throw new Error(`Packaged command failed: ${args[0]}: ${child.stderr.toString()}`);
        return child.stdout.toString();
    };
    if (!run("--version").includes(metadata.version) || !run("--help").includes("--import")) throw new Error("Wrong packaged CLI.");
    const input = join(directory, "input.nightowl.json");
    writeFileSync(input, JSON.stringify({ format: "nightowl-session", version: 1, title: "Portable smoke", notes: "Keep Sparrow", messages: [
        { id: "u", turnId: "t", role: "user", content: "Remember Sparrow", status: "completed", createdAt: 1 },
        { id: "a", turnId: "t", role: "assistant", content: "## Kept\n\n```ts\nconst name = 'Sparrow';\n```", status: "completed", createdAt: 2, provider: "ollama", model: "fixture" },
    ] }));
    run("--import", input);
    run("--rename", "Release smoke");
    const output = join(directory, "output.nightowl.json");
    run("--export", output);
    const saved = JSON.parse(readFileSync(output, "utf8"));
    if (saved.title !== "Release smoke" || saved.notes !== "Keep Sparrow" || saved.messages.length !== 2) throw new Error("Packaged session roundtrip failed.");
    const original = JSON.parse(readFileSync(input, "utf8"));
    if (saved.messages.some((message: { content: string }, index: number) => message.content !== original.messages[index].content)) throw new Error("Packaged session roundtrip changed the transcript.");
    if (!run("--sessions").includes("Release smoke")) throw new Error("Session list failed.");
    const db = new Database(join(directory, "data", "sessions.sqlite"), { readonly: true });
    if ((db.query("SELECT COUNT(*) AS count FROM attempts").get() as { count: number }).count !== 0) throw new Error("Import unexpectedly created a request attempt.");
    db.close();
    for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.txt", "BUN-LICENSE.md", "REBUILD.md"]) if (!readdirSync(directory).includes(file)) throw new Error(`Missing ${file}`);
    console.log("PASS: Windows ZIP paths/extraction, CLI, checksum, portable sessions, dotenv isolation, and license notices.");
} finally {
    const target = resolve(directory);
    if (!target.startsWith(resolve(prefix)) || target === resolve(tmpdir())) throw new Error("Unsafe smoke cleanup path.");
    rmSync(target, { recursive: true, force: true });
}
