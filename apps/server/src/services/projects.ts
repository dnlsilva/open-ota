import type { Project } from "@open-ota/shared";
import { encryptSecret, generateApiToken, generateSigningKeyPair, uuidv7 } from "@open-ota/shared";
import { eq } from "drizzle-orm";
import { channels, projects, type ProjectRow } from "../db/schema.js";
import type { AppContext } from "./context.js";
import { ApiError } from "./errors.js";
import { assertCanCreateProject } from "./orgs.js";

export const DEFAULT_CHANNELS = ["development", "staging", "production"];

export async function createProject(
  ctx: AppContext,
  input: { orgId: string; name: string; deepLinkScheme?: string },
): Promise<Project> {
  await assertCanCreateProject(ctx, input.orgId);

  const slug = slugify(input.name);
  if (!slug) throw ApiError.badRequest("invalid_name", "Give the project a name with letters or digits");

  // A signing key per project: leaking one never reaches another project, and
  // a manifest signed elsewhere cannot validate against this app's public key.
  const { publicKeyPem, privateKeyPem } = await generateSigningKeyPair();
  const id = uuidv7();

  const [row] = await ctx.db
    .insert(projects)
    .values({
      id,
      orgId: input.orgId,
      name: input.name,
      slug,
      appKey: generateApiToken("pk"),
      publicKey: publicKeyPem,
      privateKeyEnc: await encryptSecret(privateKeyPem, ctx.config.OTA_MASTER_KEY),
      deepLinkScheme: input.deepLinkScheme ?? null,
    })
    .returning();

  await ctx.db
    .insert(channels)
    .values(DEFAULT_CHANNELS.map((name) => ({ id: uuidv7(), projectId: id, name })));

  return toProjectDto(row!);
}

export async function findProjectByAppKey(ctx: AppContext, appKey: string): Promise<ProjectRow> {
  const row = await ctx.db.query.projects.findFirst({ where: eq(projects.appKey, appKey) });
  if (!row) throw ApiError.unauthorized("Unknown app key");
  return row;
}

export function toProjectDto(row: ProjectRow): Project {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    slug: row.slug,
    appKey: row.appKey,
    publicKey: row.publicKey,
    deepLinkScheme: row.deepLinkScheme,
    createdAt: row.createdAt.toISOString(),
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
