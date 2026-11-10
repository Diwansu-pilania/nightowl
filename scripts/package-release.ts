import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import metadata from "../package.json";

const root = resolve(import.meta.dir, "..");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This alpha publishes Windows x64 binaries only; use the source install on other platforms.");
if (Bun.version !== "1.4.2") throw new Error("Build releases with Bun 1.4.2.");
if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(metadata.version)) throw new Error("Expected an alpha version.");
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${metadata.version}`) throw new Error("Release tag must match the package version.");
const name = `nightowl-v${metadata.version}-windows-x64`;
const staging = join(root, "dist", "staging", `${name}-${crypto.randomUUID()}`);
const output = join(root, "dist", "releases");
mkdirSync(staging, { recursive: true }); mkdirSync(output, { recursive: true });
const binary = join(root, "dist", "nightowl.exe");
const version = Bun.spawnSync([binary, "--version"]);
if (version.exitCode !== 0 || version.stdout.toString().trim() !== `NightOwl ${metadata.version}`) throw new Error("Run bun run build:cli for the current version first.");
cpSync(binary, join(staging, "nightowl.exe"));
for (const file of ["LICENSE", "README.md", "CHANGELOG.md", "SECURITY.md"]) cpSync(join(root, file), join(staging, file));
cpSync(join(root, "docs"), join(staging, "docs"), { recursive: true });

const notices: string[] = ["NightOwl third-party notices\nGenerated from the installed dependency tree; includes transitive/development package notices conservatively.\n"];
const found = new Set<string>();
const missing: string[] = [];
const modules = join(root, "node_modules", ".bun");
for (const entry of readdirSync(modules)) {
    const nested = join(modules, entry, "node_modules");
    if (!existsSync(nested)) continue;
    for (const first of readdirSync(nested)) {
        const packagePaths = first.startsWith("@") ? readdirSync(join(nested, first)).map((second) => join(nested, first, second)) : [join(nested, first)];
        for (const candidate of packagePaths) {
            if (!existsSync(join(candidate, "package.json"))) continue;
            const path = realpathSync(candidate);
            if (found.has(path)) continue;
            found.add(path);
            const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
            // Declaration-only packages have no code in the executable.
            if (pkg.name === "bun-types" || pkg.name.startsWith("@types/")) continue;
            const files = readdirSync(path).filter((file) => /^(licen[sc]e|copying|notice|patents|authors)([-.]|$)/i.test(file));
            notices.push(`\n${"=".repeat(72)}\n${pkg.name} ${pkg.version} — ${pkg.license ?? "see included license files"}\n`);
            for (const file of files) {
                try { notices.push(`\n--- ${file} ---\n${readFileSync(join(path, file), "utf8")}\n`); }
                catch { throw new Error(`Unable to read ${pkg.name}/${file} license notice`); }
            }
            if (!files.length) {
                const fallback: Record<string, { license: string; path: string }> = {
                    "@ai-sdk/provider-utils": { license: "Apache-2.0", path: "packages/cli/node_modules/ai/LICENSE" },
                    "react-devtools-core": { license: "MIT", path: "packages/cli/node_modules/react/LICENSE" },
                };
                const upstream = fallback[pkg.name];
                if (upstream && pkg.license === upstream.license) notices.push(`Upstream monorepo license (${upstream.path}):\n${readFileSync(join(root, upstream.path), "utf8")}\n`);
                else missing.push(`${pkg.name} ${pkg.license ?? "unknown"}`);
            }
        }
    }
}
if (missing.length) throw new Error(`Missing package license files: ${missing.join(", ")}`);
writeFileSync(join(staging, "THIRD_PARTY_NOTICES.txt"), notices.join(""));
const bunLicense = await fetch("https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/LICENSE.md", { redirect: "error" });
if (!bunLicense.ok) throw new Error("Could not retrieve the pinned Bun runtime license notices.");
writeFileSync(join(staging, "BUN-LICENSE.md"), await bunLicense.text());
writeFileSync(join(staging, "REBUILD.md"), `This distribution embeds Bun 1.4.2 and OpenTUI native code.\n\nNightOwl source: https://github.com/Diwansu-pilania/nightowl/tree/v${metadata.version}\nBun source: https://github.com/oven-sh/bun/tree/bun-v1.4.2\n\nSee BUN-LICENSE.md for Bun's linked libraries and WebKit rebuilding instructions.\nTo rebuild NightOwl with a modified Bun runtime, install this tag's dependencies\nwith bun install --frozen-lockfile, then use that Bun executable to run scripts/build.ts.\nThe application source and dependency lockfile are included in GitHub's source archive.\n`);
const archive = join(output, `${name}.zip`);
if (existsSync(archive)) throw new Error(`Release archive already exists: ${archive}. Use a new version or remove the inspected generated artifact first.`);
const tar = Bun.spawnSync(["tar", "-a", "-cf", archive, "-C", staging, "."], { stdout: "inherit", stderr: "inherit" });
if (tar.exitCode !== 0) throw new Error("Could not create release archive.");
const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${hash}  ${name}.zip\n`);
console.log(`Packaged ${archive}\nSHA-256 ${hash}\nIncluded notices for ${found.size} packages.`);
