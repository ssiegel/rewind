/**
 * Server-side singleton for the Rewind instance.
 * Used by API routes to access session data.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Rewind } from "../../src/lib";

let _instancePromise: Promise<Rewind> | null = null;
const runtimeImport = new Function("u", "return import(u)") as (url: string) => Promise<{ createRewind: () => Rewind }>;

async function loadCreateRewind() {
  const distEntry = join(process.cwd(), "dist", "lib.js");

  if (!existsSync(distEntry)) {
    throw new Error(
      "Rewind library build output was not found. Run `pnpm build` before starting the app.",
    );
  }

  const moduleUrl = pathToFileURL(distEntry).href;
  const mod = await runtimeImport(moduleUrl);
  return mod.createRewind as () => Rewind;
}

export async function getRewind(): Promise<Rewind> {
  if (!_instancePromise) {
    _instancePromise = (async () => {
      const createRewind = await loadCreateRewind();
      return createRewind();
    })();
  }

  return _instancePromise;
}
