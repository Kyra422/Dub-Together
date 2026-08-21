import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "dev";
if (!["dev", "build", "start"].includes(mode)) throw new Error(`Unsupported vinext mode: ${mode}`);

const cli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));
const child = spawn(process.execPath, [cli, mode], {
  stdio: "inherit",
  env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
});

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
