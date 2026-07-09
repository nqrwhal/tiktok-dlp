import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const bridgePort = process.env.LIVE_BRIDGE_PORT || "8787";
const children = new Set();
let stopping = false;

const bridge = start(process.execPath, ["scripts/live-bridge.mjs"]);
const frontend = start("npm", ["run", "dev"], {
  NEXT_PUBLIC_ARCHIVE_API_BASE: `http://127.0.0.1:${bridgePort}`,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: projectDir,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping && code !== 0) {
      console.error(`[dev-live] ${command} stopped unexpectedly (${signal || code})`);
      stop("SIGTERM", 1);
    }
  });
  return child;
}

function stop(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
  const timer = setTimeout(() => process.exit(exitCode), 1_000);
  timer.unref();
}

void bridge;
void frontend;
