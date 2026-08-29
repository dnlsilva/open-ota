import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { StorageAdapter } from "../storage/index.js";
import type { EmailSender } from "./email.js";

export interface AppContext {
  db: Db;
  storage: StorageAdapter;
  config: AppConfig;
  email: EmailSender;
  now: () => Date;
}

/** Who is making an admin request, resolved by the auth middleware. */
export interface Actor {
  userId: string;
  orgId: string;
  tokenId: string;
  scopes: string[];
  /** null = the token covers every project in the org. */
  projectId: string | null;
}

