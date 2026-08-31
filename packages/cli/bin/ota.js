#!/usr/bin/env node
/**
 * Entry shim.
 *
 * The workspace runs from source — `@open-ota/shared` points its package entry
 * at a `.ts` file — so a compiled `dist/` alone would still pull TypeScript at
 * runtime. Hence: use `dist/` when a build produced one, otherwise register the
 * tsx loader and run `src/` directly. Same file works installed and in-repo.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/index.js", import.meta.url);

if (existsSync(fileURLToPath(dist))) {
  await import(dist.href);
} else {
  try {
    const { register } = await import("tsx/esm/api");
    register();
  } catch {
    process.stderr.write(
      "ota: no build found and tsx is not installed.\n" +
        "Run `pnpm install` in the repo, or install tsx alongside @open-ota/cli.\n",
    );
    process.exit(1);
  }
  await import(new URL("../src/index.ts", import.meta.url).href);
}
