import type { Command } from "commander";
import qrcode from "qrcode-terminal";

import { createClient } from "../client.js";
import { resolveConfig } from "../config.js";
import { note, print, printJson } from "../output.js";
import { resolveRelease } from "./releases.js";

export function registerPreview(program: Command): void {
  program
    .command("preview")
    .argument("<release>", "release id or label")
    .description("print a QR code that opens this release on a device")
    .option("--ttl <minutes>", "link lifetime", (value) => Number(value), 15)
    .option("-c, --channel <name>", "channel to resolve a label against")
    .option("--project <id>", "override the configured project id")
    .option("--json", "print as JSON")
    .action(
      async (
        target: string,
        flags: { ttl: number; channel?: string; project?: string; json?: boolean },
      ) => {
        const config = resolveConfig({ projectId: flags.project, channel: flags.channel });
        const client = createClient(config);
        const release = await resolveRelease(client, config, target);
        const link = await client.createPreviewLink(release.id, flags.ttl);

        if (flags.json) return printJson({ release, link });

        print("");
        print(await renderQr(link.url));
        print(link.url);
        note(
          `v${release.label} · ${release.platform} · expires ${link.expiresAt} · opens via ${link.scheme}://`,
        );
        note("The app must already be installed with a matching fingerprint; preview pins until exitPreview().");
      },
    );
}

export function renderQr(text: string): Promise<string> {
  return new Promise((resolvePromise) => qrcode.generate(text, { small: true }, resolvePromise));
}
