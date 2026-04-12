#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = "3838";
const DEFAULT_HOST = "127.0.0.1";
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  process.stdout.write(`OpenCode Rewind

Usage:
  opencode-rewind [serve] [--port <port>] [--host <host>]
  opencode-rewind start [--port <port>] [--host <host>]
  opencode-rewind stop
  opencode-rewind status

Commands:
  serve        Run the server in the foreground (default)
  start        Start the server in the background if needed
  stop         Stop the managed background server
  status       Show whether the managed server is reachable

Options:
  --port, -p   Port to listen on (default: ${DEFAULT_PORT})
  --host       Host to bind to (default: ${DEFAULT_HOST})
  --help       Show this help message
`);
}

function parseArgs(argv) {
  let command = "serve";
  let startIndex = 0;

  if (argv[0] && !argv[0].startsWith("-")) {
    if (["serve", "start", "stop", "status", "help"].includes(argv[0])) {
      command = argv[0];
      startIndex = 1;
    } else {
      process.stderr.write(`Unknown command: ${argv[0]}\n`);
      process.stderr.write("Run opencode-rewind --help for usage.\n");
      process.exit(1);
    }
  }

  let port = process.env.PORT || DEFAULT_PORT;
  let host = process.env.HOSTNAME || DEFAULT_HOST;

  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h" || command === "help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--port" || arg === "-p") {
      const value = argv[i + 1];
      if (!value) {
        process.stderr.write("Missing value for --port\n");
        process.exit(1);
      }
      port = value;
      i++;
      continue;
    }
    if (arg === "--host") {
      const value = argv[i + 1];
      if (!value) {
        process.stderr.write("Missing value for --host\n");
        process.exit(1);
      }
      host = value;
      i++;
      continue;
    }

    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.stderr.write("Run opencode-rewind --help for usage.\n");
    process.exit(1);
  }

  return { command, port, host };
}

function getStateDir() {
  return process.env.OPENCODE_REWIND_STATE_DIR || join(homedir(), ".opencode-rewind");
}

function getStatePaths() {
  const dir = getStateDir();
  return {
    dir,
    stateFile: join(dir, "server.json"),
    logFile: join(dir, "server.log"),
  };
}

function ensureStateDir() {
  mkdirSync(getStatePaths().dir, { recursive: true });
}

function readState() {
  const { stateFile } = getStatePaths();
  if (!existsSync(stateFile)) return null;

  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  ensureStateDir();
  writeFileSync(getStatePaths().stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function clearState() {
  rmSync(getStatePaths().stateFile, { force: true });
}

function baseUrlFor(host, port) {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

async function checkServerHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkServerHealth(baseUrl)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function isProcessRunning(pid) {
  if (!pid) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(pid) {
  if (!pid || !isProcessRunning(pid)) return true;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }

  await sleep(POLL_INTERVAL_MS);
  return !isProcessRunning(pid);
}

const { command, port, host } = parseArgs(process.argv.slice(2));
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = join(packageRoot, "node_modules", "next", "dist", "bin", "next");
const nextBuildId = join(packageRoot, ".next", "BUILD_ID");

function ensureServerBundle() {
  if (!existsSync(nextBin) || !existsSync(nextBuildId)) {
    process.stderr.write(
      "OpenCode Rewind build output was not found. Reinstall the package or rebuild it before running the CLI.\n",
    );
    process.exit(1);
  }
}

function spawnNextStart(options) {
  return spawn(process.execPath, [nextBin, "start", "-p", port, "-H", host], {
    cwd: packageRoot,
    ...options,
    env: {
      ...process.env,
      PORT: port,
      HOSTNAME: host,
      NODE_ENV: process.env.NODE_ENV || "production",
      ...options?.env,
    },
  });
}

async function handleServe() {
  ensureServerBundle();

  const child = spawnNextStart({ stdio: "inherit" });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function handleStart() {
  ensureServerBundle();

  const baseUrl = baseUrlFor(host, port);
  if (await checkServerHealth(baseUrl)) {
    process.stdout.write(`Rewind server already running at ${baseUrl}\n`);
    return;
  }

  const state = readState();
  if (state?.pid && isProcessRunning(state.pid)) {
    await stopProcess(state.pid);
  }
  clearState();

  ensureStateDir();
  const { logFile } = getStatePaths();
  const outFd = openSync(logFile, "a");
  const child = spawnNextStart({
    detached: true,
    stdio: ["ignore", outFd, outFd],
  });

  child.unref();

  writeState({
    pid: child.pid,
    host,
    port,
    logFile,
    startedAt: new Date().toISOString(),
  });

  const healthy = await waitForHealthy(baseUrl, START_TIMEOUT_MS);
  if (!healthy) {
    await stopProcess(child.pid);
    clearState();
    process.stderr.write(`Timed out waiting for Rewind to start at ${baseUrl}.\n`);
    process.exit(1);
  }

  process.stdout.write(`Started Rewind server at ${baseUrl}\n`);
}

async function handleStop() {
  const state = readState();
  if (!state) {
    const baseUrl = baseUrlFor(host, port);
    if (await checkServerHealth(baseUrl)) {
      process.stderr.write(
        `Rewind is responding at ${baseUrl}, but it is not managed by this CLI and cannot be stopped automatically.\n`,
      );
      process.exit(1);
    }

    process.stdout.write("Rewind server is not running.\n");
    return;
  }

  const baseUrl = baseUrlFor(state.host, state.port);
  const stopped = await stopProcess(state.pid);
  clearState();

  if (!stopped) {
    process.stderr.write(`Failed to stop Rewind server process ${state.pid}.\n`);
    process.exit(1);
  }

  if (await checkServerHealth(baseUrl)) {
    process.stderr.write(
      `Stopped the managed process, but Rewind is still responding at ${baseUrl}. Another process may still be using that port.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(`Stopped Rewind server at ${baseUrl}\n`);
}

async function handleStatus() {
  const state = readState();
  const effectiveHost = state?.host || host;
  const effectivePort = state?.port || port;
  const baseUrl = baseUrlFor(effectiveHost, effectivePort);

  if (await checkServerHealth(baseUrl)) {
    process.stdout.write(`running ${baseUrl}\n`);
    return;
  }

  if (state?.pid && isProcessRunning(state.pid)) {
    process.stdout.write(`starting ${baseUrl}\n`);
    return;
  }

  process.stdout.write("stopped\n");
}

switch (command) {
  case "serve":
    await handleServe();
    break;
  case "start":
    await handleStart();
    break;
  case "stop":
    await handleStop();
    break;
  case "status":
    await handleStatus();
    break;
  default:
    printHelp();
    process.exit(1);
}
