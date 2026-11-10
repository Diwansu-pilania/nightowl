import { expect, test } from "bun:test";
import { parseOptions } from "./options";

test("resume/list/new options and invalid requests", () => {
    expect(parseOptions(["--resume", "session-id"]).sessionId).toBe("session-id");
    expect(parseOptions(["--sessions"]).list).toBe(true);
    expect(parseOptions(["--new"]).startNew).toBe(true);
    expect(() => parseOptions(["--resume"])).toThrow("needs a session ID");
    expect(() => parseOptions(["--resume", "--new"])).toThrow("needs a session ID");
    expect(() => parseOptions(["--resume", "id", "--new"])).toThrow("either");
    expect(() => parseOptions(["--nope"])).toThrow("Unknown option");
});

test("portable commands select one operation and allow resume only for export or rename", () => {
    expect(parseOptions(["--resume", "id", "--export", "path with spaces.json"])).toMatchObject({ sessionId: "id", exportPath: "path with spaces.json" });
    expect(parseOptions(["--rename", "Sparrow plan", "--resume", "id"])).toMatchObject({ sessionId: "id", title: "Sparrow plan" });
    expect(parseOptions(["--import", "chat.json"]).importPath).toBe("chat.json");
    for (const args of [
        ["--import"], ["--export"], ["--rename"],
        ["--import", "chat.json", "--resume", "id"],
        ["--export", "chat.json", "--new"],
        ["--import", "chat.json", "--setup"],
        ["--rename", "title", "--sessions"],
        ["--export", "chat.json", "--rename", "title"],
    ]) expect(() => parseOptions(args)).toThrow();
});
