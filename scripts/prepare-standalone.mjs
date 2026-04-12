import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const standaloneDir = join(root, ".next", "standalone");
const standaloneServer = join(standaloneDir, "server.js");

if (!existsSync(standaloneServer)) {
  throw new Error("Expected .next/standalone/server.js after next build");
}

const staticSrc = join(root, ".next", "static");
const staticDest = join(standaloneDir, ".next", "static");

if (existsSync(staticSrc)) {
  await mkdir(join(standaloneDir, ".next"), { recursive: true });
  await rm(staticDest, { recursive: true, force: true });
  await cp(staticSrc, staticDest, { recursive: true });
}

const publicSrc = join(root, "public");
const publicDest = join(standaloneDir, "public");

if (existsSync(publicSrc)) {
  await rm(publicDest, { recursive: true, force: true });
  await cp(publicSrc, publicDest, { recursive: true });
}
