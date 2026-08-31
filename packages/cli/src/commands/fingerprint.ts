import { writeFileSync } from "node:fs";
import type { Command } from "commander";

import { FINGERPRINT_FILE, resolveConfig } from "../config.js";
import { computeFingerprint, fingerprintPath, readFingerprint } from "../fingerprint.js";
import { fail, note, ok, printJson, warn } from "../output.js";

export function registerFingerprint(program: Command): void {
  program
    .command("fingerprint")
    .description(`compute the native fingerprint and write ${FINGERPRINT_FILE}`)
    .option("--check", "fail instead of writing when the fingerprint drifted (CI)")
    .option("--json", "print the fingerprint as JSON")
    .action(async (options: { check?: boolean; json?: boolean }) => {
      const { projectRoot } = resolveConfig();
      const current = await computeFingerprint(projectRoot);
      const committed = readFingerprint(projectRoot);

      if (options.check) {
        if (!committed) {
          fail(
            `No ${FINGERPRINT_FILE} committed.`,
            "Run `ota fingerprint` and commit the result so CI has something to compare against.",
          );
        }
        if (committed.hash !== current.hash) {
          fail(
            `Fingerprint drift: ${FINGERPRINT_FILE} says ${short(committed.hash)}, the project hashes to ${short(current.hash)}.`,
            "The native project changed. Run `ota fingerprint`, commit it, and ship a new binary — old OTA releases no longer match this build.",
          );
        }
        if (options.json) printJson(committed);
        else ok(`Fingerprint matches (${committed.runtimeVersion}).`);
        return;
      }

      if (committed && committed.hash !== current.hash) {
        warn(`Fingerprint changed: ${short(committed.hash)} → ${short(current.hash)}`);
        note("Releases published against the old fingerprint stop being offered to new builds.");
      }

      writeFileSync(fingerprintPath(projectRoot), `${JSON.stringify(current, null, 2)}\n`);
      if (options.json) printJson(current);
      else {
        ok(`Wrote ${FINGERPRINT_FILE} — ${current.runtimeVersion}`);
        note("Commit it: this is the contract between a bundle and the binaries allowed to run it.");
      }
    });
}

function short(hash: string): string {
  return hash.slice(0, 12);
}
