import { spawn, spawnSync } from "node:child_process";

import { UserError } from "./output.js";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Capture stdout instead of streaming it to the terminal. */
  capture?: boolean;
}

export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      shell: false,
    });

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      rejectPromise(
        error.code === "ENOENT"
          ? new UserError(`\`${command}\` not found on PATH.`, `Install it, then run this command again.`)
          : error,
      );
    });

    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new UserError(`\`${command} ${args.join(" ")}\` exited with code ${code}.`));
    });
  });
}

export function hasCommand(command: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
  return probe.status === 0;
}

export function gitCommit(cwd: string): string | undefined {
  const probe = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : undefined;
}
