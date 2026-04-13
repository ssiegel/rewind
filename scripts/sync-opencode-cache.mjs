import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

async function replacePath(source, target) {
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
}

const root = process.cwd();
const targetDir = resolveCachePackageDir();

if (!existsSync(targetDir)) {
  throw new Error(
    `OpenCode cache package not found at ${targetDir}. Install or restart OpenCode with the npm plugin configured once before syncing local builds.`,
  );
}

for (const name of ["dist", "bin", ".next"]) {
  const source = join(root, name);
  if (!existsSync(source)) {
    throw new Error(`Missing ${name} at ${source}. Run the build steps before syncing.`);
  }
  await replacePath(source, join(targetDir, name));
}

for (const name of ["package.json", "README.md"] ) {
  const source = join(root, name);
  if (!existsSync(source)) {
    throw new Error(`Missing ${name} at ${source}.`);
  }
  await cp(source, join(targetDir, name), { force: true });
}

process.stdout.write(`Synced local build into OpenCode cache:\n${targetDir}\n`);
