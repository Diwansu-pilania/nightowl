import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getDataDirectory(
    env: Record<string, string | undefined> = process.env,
    platform: string = process.platform,
    home = homedir(),
): string {
    if (env.NIGHTOWL_DATA_DIR?.trim()) return resolve(env.NIGHTOWL_DATA_DIR.trim());
    if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "NightOwl");
    if (platform === "darwin") return join(home, "Library", "Application Support", "NightOwl");
    return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "nightowl");
}

/** Resolves symlinks so launching through an alias resumes the same workspace. */
export function canonicalWorkspace(path: string): string {
    const canonical = realpathSync(path);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
