import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const gatewayPort = positiveInteger(process.env.LIVE_GATEWAY_PORT, 3000);
const bridgePort = positiveInteger(process.env.LIVE_BRIDGE_PORT, 8787);
const frontendPort = positiveInteger(process.env.LIVE_FRONTEND_PORT, 3001);
const children = new Set();
let stopping = false;

start(process.execPath, ["scripts/live-bridge.mjs"]);
start("npm", ["run", "start", "--", "--port", String(frontendPort), "--hostname", "0.0.0.0"]);

const gateway = http.createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://rewind.local").pathname;
  const targetPort = /^\/(?:api(?:\/|$)|media\/|thumbnail\/)/.test(pathname)
    ? bridgePort
    : frontendPort;
  proxyRequest(request, response, targetPort);
});

gateway.listen(gatewayPort, "0.0.0.0", () => {
  console.log(`[rewind] App available at http://0.0.0.0:${gatewayPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

function proxyRequest(request, response, targetPort) {
  const forwardedFor = [request.headers["x-forwarded-for"], request.socket.remoteAddress]
    .filter(Boolean)
    .join(", ");
  const headers = {
    ...request.headers,
    host: request.headers.host,
    "x-forwarded-for": forwardedFor,
    "x-forwarded-host": request.headers.host || "",
    "x-forwarded-proto": request.headers["x-forwarded-proto"] || "http",
  };
  const upstream = http.request({
    host: "127.0.0.1",
    port: targetPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Rewind service is starting" }));
  });
  request.pipe(upstream);
}

function start(command, args) {
  const child = spawn(command, args, {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[rewind] ${command} stopped unexpectedly (${signal || code})`);
      stop("SIGTERM", 1);
    }
  });
}

function stop(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  gateway.close();
  for (const child of children) child.kill(signal);
  const timer = setTimeout(() => process.exit(exitCode), 1_000);
  timer.unref();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
