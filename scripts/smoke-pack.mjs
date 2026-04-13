import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

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

function runJson(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}\n${stderr}`));
        return;
      }

      try {
        const match = stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
        if (!match) {
          throw new Error(`Could not locate JSON output from ${command} ${args.join(" ")}`);
        }
        resolve(JSON.parse(match[1]));
      } catch (error) {
        reject(error);
      }
    });
    child.on("error", reject);
  });
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${url} -> ${response.status}`);
  }
  return response.text();
}

async function assertPluginRootExports(prefixDir, cwd) {
  const packageRoot = join(prefixDir, "lib", "node_modules", "opencode-rewind");
  const snippet = [
    "import(path).then((mod) => {",
    "  const keys = Object.keys(mod);",
    "  console.log(JSON.stringify(keys));",
    "  if (keys.length !== 1 || keys[0] !== 'default') process.exit(1);",
    "})",
    ".catch((error) => { console.error(error); process.exit(1); });",
  ].join(" ");

  await run(process.execPath, ["-e", `const path = new URL('./dist/index.js', 'file://${packageRoot}/').href; ${snippet}`], { cwd });
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

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "opencode-rewind-pack-"));
const packDir = join(tempRoot, "pack");
const prefixDir = join(tempRoot, "prefix");
const stateDir = join(tempRoot, "state");
const port = String(3900 + Math.floor(Math.random() * 500));
const cliPath = join(prefixDir, "bin", process.platform === "win32" ? "opencode-rewind.cmd" : "opencode-rewind");
let started = false;

try {
  await mkdir(packDir, { recursive: true });
  const packResult = await runJson("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: root });
  const tarballName = packResult[0]?.filename;
  if (!tarballName) {
    throw new Error("npm pack did not return a tarball filename");
  }

  await run("npm", ["install", "-g", "--prefix", prefixDir, join(packDir, tarballName)], { cwd: root });
  await assertPluginRootExports(prefixDir, root);
  await run(cliPath, ["start", "--port", port], {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_REWIND_STATE_DIR: stateDir,
    },
  });
  started = true;

  await waitFor(`http://127.0.0.1:${port}/api/health`, 15000);
  const sessions = await fetchText(`http://127.0.0.1:${port}/api/sessions?limit=1`);
  process.stdout.write(`${sessions}\n`);

} finally {
  if (started) {
    try {
      await run(cliPath, ["stop"], {
        cwd: root,
        env: {
          ...process.env,
          OPENCODE_REWIND_STATE_DIR: stateDir,
        },
      });
    } catch {}
  }
  await rm(tempRoot, { recursive: true, force: true });
}
