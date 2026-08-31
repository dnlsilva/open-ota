import type { Command } from "commander";
import { OtaApiError, OtaClient } from "@open-ota/shared";

import { loadGlobalConfig, resolveConfig, saveGlobalConfig } from "../config.js";
import { fail, note, ok } from "../output.js";
import { ask } from "../prompt.js";

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("store the API url and a token in ~/.config/open-ota/config.json")
    .option("--url <url>", "API base url (skips the prompt)")
    .option("--token <token>", "API token (skips the prompt)")
    .action(async (options: { url?: string; token?: string }) => {
      const config = resolveConfig();

      const apiUrl =
        options.url ??
        config.apiUrl ??
        (
          await ask<"apiUrl">({
            type: "text",
            name: "apiUrl",
            message: "API url",
            initial: "http://localhost:3000",
          })
        ).apiUrl;

      const token = options.token ?? (await obtainToken(apiUrl));

      const client = new OtaClient({ baseUrl: apiUrl, token });
      try {
        await client.listProjects();
      } catch (error) {
        if (error instanceof OtaApiError && (error.status === 401 || error.status === 403)) {
          fail("The server rejected that token.", "Check it was copied whole, and has not been revoked.");
        }
        throw error;
      }

      const path = saveGlobalConfig({ ...loadGlobalConfig(), apiUrl, token });
      ok(`Signed in to ${apiUrl}`);
      note(`Credentials written to ${path} (0600).`);
      note("OTA_API_URL and OTA_TOKEN override this file.");
    });
}

async function obtainToken(apiUrl: string): Promise<string> {
  const { method } = await ask<"method">({
    type: "select",
    name: "method",
    message: "How do you want to authenticate?",
    choices: [
      { title: "Paste an API token", value: "token" },
      { title: "Email and password", value: "password" },
    ],
  });

  if (method === "token") {
    const { token } = await ask<"token">({
      type: "password",
      name: "token",
      message: "API token (ota_...)",
    });
    if (!token) fail("No token entered.");
    return token as string;
  }

  const credentials = await ask<"email" | "password">([
    { type: "text", name: "email", message: "Email" },
    { type: "password", name: "password", message: "Password" },
  ]);

  const client = new OtaClient({ baseUrl: apiUrl });
  try {
    const { token } = await client.login(credentials.email as string, credentials.password as string);
    return token;
  } catch (error) {
    if (error instanceof OtaApiError && error.status === 401) fail("Wrong email or password.");
    throw error;
  }
}
