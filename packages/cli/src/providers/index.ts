/**
 * Backend provisioning for `ota init --provider ...`.
 *
 * Every provider is a flat list of steps so the same list can be printed
 * (`--dry-run`) or executed. Two safety rules, both enforced by the runner:
 * a step whose command still contains a `<placeholder>` is printed and never
 * run, and a step marked destructive is confirmed first.
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

import { bold, dim } from "kleur/colors";

import { exec, hasCommand } from "../exec.js";
import { info, note, ok, print, warn } from "../output.js";
import { confirm } from "../prompt.js";
import { cloudflareProvider } from "./cloudflare.js";
import { dockerProvider } from "./docker.js";
import { supabaseProvider } from "./supabase.js";

export const PROVIDER_NAMES = ["supabase", "cloudflare", "docker"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProvisionContext {
  projectRoot: string;
  projectId: string;
  apiUrl: string;
  bucket: string;
  masterKey: string;
}

export interface ProvisionStep {
  title: string;
  command?: string[];
  write?: { path: string; contents: string };
  /** Changes remote state — confirmed before running. */
  destructive?: boolean;
  /** Extra guidance printed under the step. */
  note?: string;
}

export interface Provider {
  name: ProviderName;
  /** Executables the steps need on PATH. */
  requires: string[];
  steps(context: ProvisionContext): ProvisionStep[];
}

const PROVIDERS: Record<ProviderName, Provider> = {
  supabase: supabaseProvider,
  cloudflare: cloudflareProvider,
  docker: dockerProvider,
};

export function getProvider(name: string): Provider | null {
  return PROVIDERS[name as ProviderName] ?? null;
}

export interface ProvisionOptions {
  dryRun?: boolean;
  /** Skip the confirmation on destructive steps (CI). */
  yes?: boolean;
}

export async function runProvision(
  provider: Provider,
  context: ProvisionContext,
  options: ProvisionOptions = {},
): Promise<void> {
  const missing = provider.requires.filter((binary) => !hasCommand(binary));
  const dryRun = options.dryRun || missing.length > 0;

  print("");
  print(bold(`Provisioning: ${provider.name}`));
  if (missing.length > 0) {
    warn(`${missing.join(", ")} not found on PATH — printing the steps instead of running them.`);
  } else if (options.dryRun) {
    note("Dry run — nothing below is executed.");
  }

  for (const step of provider.steps(context)) {
    print("");
    print(bold(step.title));
    if (step.note) note(step.note);

    if (step.write) {
      const target = join(context.projectRoot, step.write.path);
      print(dim(`  write ${step.write.path}`));
      if (dryRun) continue;
      if (existsSync(target) && !options.yes && !(await confirm(`Overwrite ${step.write.path}?`))) {
        note("  skipped");
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, step.write.contents);
      ok(`  wrote ${step.write.path}`);
      continue;
    }

    if (!step.command) continue;

    const printable = step.command.join(" ");
    print(dim(`  $ ${printable}`));

    if (hasPlaceholder(step.command)) {
      note("  fill in the placeholder and run this one yourself");
      continue;
    }
    if (dryRun) continue;
    if (step.destructive && !options.yes && !(await confirm(`Run \`${printable}\`?`))) {
      note("  skipped");
      continue;
    }

    const [binary, ...args] = step.command;
    await exec(binary as string, args, { cwd: context.projectRoot });
  }

  print("");
  info(dryRun ? "Provisioning steps printed — run them when ready." : "Provisioning finished.");
}

function hasPlaceholder(command: string[]): boolean {
  return command.some((part) => /<[^>]+>/.test(part));
}
