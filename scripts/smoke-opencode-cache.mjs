import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function resolveCachePackageDir() {
  return process.env.OPENCODE_REWIND_CACHE_DIR || join(
    homedir(),
    ".cache",
    "opencode",
    "packages",
    "opencode-rewind@latest",
    "node_modules",
    "opencode-rewind",
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}`));
    });
    child.on("error", reject);
  });
}

async function assertPluginRootExports(targetDir) {
  const moduleUrl = new URL(`file://${join(targetDir, "dist", "index.js")}`).href;
  const script = [
    `import(${JSON.stringify(moduleUrl)}).then((mod) => {`,
    "  const keys = Object.keys(mod);",
    "  console.log(JSON.stringify(keys));",
    "  if (keys.length !== 1 || keys[0] !== 'default') process.exit(1);",
    "}).catch((error) => { console.error(error); process.exit(1); });",
  ].join(" ");
  await run(process.execPath, ["-e", script]);
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const targetDir = resolveCachePackageDir();
const cliPath = join(targetDir, "bin", "opencode-rewind.js");
const port = String(3900 + Math.floor(Math.random() * 500));
const stateDir = await mkdtemp(join(tmpdir(), "opencode-rewind-cache-"));
let started = false;

if (!existsSync(cliPath)) {
  throw new Error(`Cached Rewind CLI not found at ${cliPath}. Sync or install the plugin first.`);
}

try {
  await assertPluginRootExports(targetDir);
  await run(cliPath, ["start", "--port", port], {
    env: {
      ...process.env,
      OPENCODE_REWIND_STATE_DIR: stateDir,
    },
  });
  started = true;

  await waitFor(`http://127.0.0.1:${port}/api/health`, 15000);
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions?limit=1`);
  if (!response.ok) {
    throw new Error(`Session API failed with ${response.status}`);
  }

  const text = await response.text();
  process.stdout.write(`${text}\n`);
} finally {
  if (started) {
    try {
      await run(cliPath, ["stop"], {
        env: {
          ...process.env,
          OPENCODE_REWIND_STATE_DIR: stateDir,
        },
      });
    } catch {}
  }
  await rm(stateDir, { recursive: true, force: true });
}
