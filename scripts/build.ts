import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = `dist/nightowl${process.platform === "win32" ? ".exe" : ""}`;
const child = Bun.spawn([
    process.execPath, "build", "--compile",
    "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
    "--outfile", output, "packages/cli/src/index.tsx",
], { cwd: root, stdout: "inherit", stderr: "inherit" });
const code = await child.exited;
if (code !== 0) process.exit(code);
console.log(`Built ${output} for ${process.platform}/${process.arch}. Test on the target OS before distributing.`);
