import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { getDataDirectory } from "./paths";

test("selects OS data paths and supports an explicit isolated data directory", () => {
    expect(getDataDirectory({ NIGHTOWL_DATA_DIR: "custom-state" })).toBe(resolve("custom-state"));
    expect(getDataDirectory({ LOCALAPPDATA: "local-data" }, "win32", "home")).toBe(join("local-data", "NightOwl"));
    expect(getDataDirectory({}, "darwin", "home")).toBe(join("home", "Library", "Application Support", "NightOwl"));
    expect(getDataDirectory({ XDG_DATA_HOME: "xdg" }, "linux", "home")).toBe(join("xdg", "nightowl"));
});
