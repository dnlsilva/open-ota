/**
 * Serves the dashboard SPA locally against a remote Admin API — the story for
 * the edge targets, where nothing hosts static files for us (ARCHITECTURE §2).
 */

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { dim } from "kleur/colors";

import { requireApi, resolveConfig } from "../config.js";
import { fail, info, note, print } from "../output.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

export function registerConsole(program: Command): void {
  program
    .command("console")
    .description("serve the dashboard locally, pointed at your API")
    .option("--port <port>", "port to listen on", (value) => Number(value), 4321)
    .option("--dist <dir>", "dashboard build directory")
    .action(async (flags: { port: number; dist?: string }) => {
      const config = resolveConfig();
      const { apiUrl, token } = requireApi(config);
      const dist = flags.dist ? resolve(flags.dist) : findDashboardDist();

      if (!dist) {
        fail(
          "No dashboard build found.",
          "Build it once — `pnpm --filter @open-ota/dashboard build` — or point at one with --dist.",
        );
      }

      const index = join(dist, "index.html");
      if (!existsSync(index)) fail(`${dist} has no index.html.`);

      const server = createServer((request, response) => {
        const path = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
        const file = safeJoin(dist, path);
        const target = file && existsSync(file) && extname(file) ? file : index;
        const body =
          target === index ? injectConfig(readFileSync(index, "utf8"), apiUrl, token) : readFileSync(target);

        response.writeHead(200, {
          "content-type": MIME[extname(target)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        response.end(body);
      });

      server.listen(flags.port, () => {
        info(`Dashboard on http://localhost:${flags.port}`);
        note(dim(`serving ${dist} against ${apiUrl}`));
        print("");
        note("Press Ctrl+C to stop.");
      });
    });
}

/**
 * The SPA is built once and pointed anywhere, so the api url and the token
 * arrive at runtime instead of at build time.
 */
function injectConfig(html: string, apiUrl: string, token: string): string {
  const script = `<script>window.__OTA_CONSOLE__=${JSON.stringify({ apiUrl, token })}</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${script}</head>`) : `${script}${html}`;
}

function safeJoin(root: string, path: string): string | null {
  const joined = normalize(join(root, path));
  return joined.startsWith(root) ? joined : null;
}

/** The dist may sit in the app's node_modules, or in the monorepo checkout. */
function findDashboardDist(): string | null {
  const fromEnv = process.env.OTA_DASHBOARD_DIST;
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv);

  const candidates = [join(process.cwd(), "node_modules", "@open-ota", "dashboard", "dist")];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(dir, "apps", "dashboard", "dist"));
    candidates.push(join(dir, "node_modules", "@open-ota", "dashboard", "dist"));
    dir = dirname(dir);
  }
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? null;
}
