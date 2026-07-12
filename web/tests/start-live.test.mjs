import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("start-live fails when a child exits cleanly", async (context) => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "rewind-supervisor-"));
  context.after(() => rm(fixtureDir, { recursive: true, force: true }));

  const fakeNpm = path.join(fixtureDir, "npm");
  await writeFile(fakeNpm, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await chmod(fakeNpm, 0o755);
  const [gatewayPort, bridgePort, frontendPort] = await reservePorts(3);

  const child = spawn(process.execPath, ["scripts/start-live.mjs"], {
    cwd: projectDir,
    env: {
      ...process.env,
      PATH: `${fixtureDir}${path.delimiter}${process.env.PATH || ""}`,
      LIVE_GATEWAY_PORT: String(gatewayPort),
      LIVE_BRIDGE_PORT: String(bridgePort),
      LIVE_FRONTEND_PORT: String(frontendPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const result = await waitForExit(child);
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(stderr, /npm stopped unexpectedly \(0\)/);
});

async function reservePorts(count) {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  })));
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  return ports;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("start-live did not exit after its child stopped"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
