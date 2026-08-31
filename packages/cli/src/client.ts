import { OtaClient } from "@open-ota/shared";

import { requireApi, type ResolvedConfig } from "./config.js";

export function createClient(config: ResolvedConfig): OtaClient {
  const { apiUrl, token } = requireApi(config);
  return new OtaClient({ baseUrl: apiUrl, token });
}
