/**
 * Minimal OAuth 2.1 authorization server — just enough that
 * `claude mcp add --transport http ota https://…/mcp` connects in one command:
 * the 401 advertises this server, the client registers itself and runs PKCE.
 *
 * PKCE with S256 is mandatory, clients are public (no secret), and the access
 * tokens it issues ARE `api_tokens` rows with kind "oauth": one token system,
 * one revocation path. docs/API.md §1, docs/ARCHITECTURE.md §3.5.
 *
 * Every failure here uses the RFC 6749 §5.2 `{error, error_description}` shape,
 * because that is what OAuth clients parse — not the app's ApiError body.
 */

import { bytesToBase64Url, generateApiToken, hashToken, timingSafeEqual, utf8 } from "@open-ota/shared";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { apiTokens, oauthClients, oauthCodes } from "../db/schema.js";
import { issueToken, login } from "../services/auth.js";
import type { AppContext } from "../services/context.js";

/** Short enough that a leaked code is worthless, long enough for a slow login. */
const CODE_TTL_SECONDS = 120;
/** Long enough that an agent session never re-auths mid-task; refresh rotates it. */
const ACCESS_TOKEN_TTL_DAYS = 30;

const registrationSchema = z.object({
  client_name: z.string().min(1).max(120),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
});

interface AuthorizeParams {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  code_challenge: string;
}

export function oauthRoutes() {
  const app = new Hono<AppEnv>();

  /* --------------------------------------------- RFC 7591 registration */

  app.post("/register", async (c) => {
    const ctx = c.get("ctx");
    const parsed = registrationSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return oauthError(c, 400, "invalid_client_metadata", "client_name and redirect_uris are required");
    }

    const clientId = generateApiToken("mcp");
    await ctx.db.insert(oauthClients).values({
      id: clientId,
      clientName: parsed.data.client_name,
      redirectUris: parsed.data.redirect_uris,
    });

    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(ctx.now().getTime() / 1000),
        client_name: parsed.data.client_name,
        redirect_uris: parsed.data.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Public client: a CLI or desktop agent cannot keep a secret, so PKCE
        // is the proof of possession instead.
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  /* ------------------------------------------------------- authorize */

  app.get("/authorize", async (c) => {
    const checked = await checkAuthorize(c.get("ctx"), c.req.query());
    if ("error" in checked) return oauthError(c, 400, checked.error, checked.description);
    return c.html(loginPage(checked.params, null));
  });

  app.post("/authorize", async (c) => {
    const ctx = c.get("ctx");
    const form = await readForm(c);
    const checked = await checkAuthorize(ctx, form);
    if ("error" in checked) return oauthError(c, 400, checked.error, checked.description);
    const params = checked.params;

    // No session exists to reuse: this server authenticates with Bearer tokens
    // only (docs/API.md §1), so consent always asks for the password.
    let session: Awaited<ReturnType<typeof login>>;
    try {
      session = await login(ctx, {
        email: form.email ?? "",
        password: form.password ?? "",
        tokenName: "oauth-consent",
      });
    } catch {
      // A wrong password is a UI failure, not a protocol one — re-render rather
      // than bouncing an OAuth error at the client.
      return c.html(loginPage(params, "Wrong email or password"), 401);
    }

    // login() is the one place password checking lives; the session token it
    // mints is not the OAuth token, so it goes straight back out.
    await ctx.db.delete(apiTokens).where(eq(apiTokens.tokenHash, await hashToken(session.token)));

    const org = session.orgs[0];
    if (!org) return c.html(loginPage(params, "That account is not in any organisation"), 403);

    const code = generateApiToken("otac");
    await ctx.db.insert(oauthCodes).values({
      code,
      clientId: params.client_id,
      userId: session.user.id,
      orgId: org.id,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: "S256",
      scope: params.scope,
      expiresAt: new Date(ctx.now().getTime() + CODE_TTL_SECONDS * 1000),
    });

    const target = new URL(params.redirect_uri);
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    return c.redirect(target.toString(), 302);
  });

  /* ----------------------------------------------------------- token */

  app.post("/token", async (c) => {
    const ctx = c.get("ctx");
    const form = await readForm(c);

    if (form.grant_type === "refresh_token") {
      if (!form.refresh_token) {
        return oauthError(c, 400, "invalid_request", "refresh_token is required");
      }
      const row = await ctx.db.query.apiTokens.findFirst({
        where: eq(apiTokens.refreshTokenHash, await hashToken(form.refresh_token)),
      });
      if (!row) return oauthError(c, 400, "invalid_grant", "That refresh token is not valid");

      // Rotation: the access token dies with the refresh token that minted it.
      await ctx.db.delete(apiTokens).where(eq(apiTokens.id, row.id));
      return c.json(
        await issueGrant(ctx, {
          userId: row.userId,
          orgId: row.orgId,
          scope: row.scopes.join(" "),
          clientName: row.name,
        }),
      );
    }

    if (form.grant_type !== "authorization_code") {
      return oauthError(
        c,
        400,
        "unsupported_grant_type",
        "Only authorization_code and refresh_token are supported",
      );
    }
    if (!form.code) return oauthError(c, 400, "invalid_request", "code is required");

    const row = await ctx.db.query.oauthCodes.findFirst({ where: eq(oauthCodes.code, form.code) });
    if (!row) return oauthError(c, 400, "invalid_grant", "That authorization code is not valid");

    // Burn it before validating anything else, so a code is single-use whether
    // the exchange succeeds or fails.
    await ctx.db.delete(oauthCodes).where(eq(oauthCodes.code, row.code));

    if (row.expiresAt < ctx.now()) {
      return oauthError(c, 400, "invalid_grant", "That authorization code has expired");
    }
    if (row.clientId !== form.client_id) {
      return oauthError(c, 400, "invalid_grant", "That code was issued to a different client");
    }
    if (row.redirectUri !== form.redirect_uri) {
      return oauthError(c, 400, "invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!form.code_verifier || !timingSafeEqual(await s256(form.code_verifier), row.codeChallenge)) {
      return oauthError(c, 400, "invalid_grant", "code_verifier does not match the code_challenge");
    }

    return c.json(
      await issueGrant(ctx, {
        userId: row.userId,
        orgId: row.orgId,
        scope: row.scope,
        clientName: `mcp:${row.clientId}`,
      }),
    );
  });

  return app;
}

/* ---------------------------------------------------------------- grants */

async function issueGrant(
  ctx: AppContext,
  input: { userId: string; orgId: string; scope: string; clientName: string },
) {
  const { id, token } = await issueToken(ctx, {
    userId: input.userId,
    orgId: input.orgId,
    name: input.clientName,
    scopes: input.scope.split(" ").filter(Boolean),
    kind: "oauth",
    expiresInDays: ACCESS_TOKEN_TTL_DAYS,
  });

  const refreshToken = generateApiToken("otar");
  await ctx.db
    .update(apiTokens)
    .set({ refreshTokenHash: await hashToken(refreshToken) })
    .where(eq(apiTokens.id, id));

  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_DAYS * 86_400,
    refresh_token: refreshToken,
    scope: input.scope,
  };
}

/* ------------------------------------------------------------ validation */

type AuthorizeCheck =
  | { params: AuthorizeParams }
  | { error: string; description: string };

async function checkAuthorize(
  ctx: AppContext,
  raw: Record<string, string | undefined>,
): Promise<AuthorizeCheck> {
  const clientId = raw.client_id ?? "";
  if (!clientId) return { error: "invalid_request", description: "client_id is required" };

  const client = await ctx.db.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId) });
  if (!client) return { error: "invalid_client", description: "Unknown client_id" };

  // Exact match against the registered set — never a prefix or origin check,
  // which is how authorization codes get delivered to the wrong place.
  const redirectUri = raw.redirect_uri ?? "";
  if (!client.redirectUris.includes(redirectUri)) {
    return { error: "invalid_request", description: "redirect_uri is not registered for this client" };
  }

  if ((raw.response_type ?? "") !== "code") {
    return { error: "unsupported_response_type", description: "Only response_type=code is supported" };
  }
  if ((raw.code_challenge_method ?? "") !== "S256") {
    return { error: "invalid_request", description: "code_challenge_method must be S256" };
  }

  const challenge = raw.code_challenge ?? "";
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) {
    return { error: "invalid_request", description: "code_challenge must be a base64url S256 digest" };
  }

  const requested = (raw.scope ?? "").split(" ").filter(Boolean);
  if (requested.some((s) => s !== "admin" && s !== "read")) {
    return { error: "invalid_scope", description: "Supported scopes are admin and read" };
  }

  return {
    params: {
      client_id: clientId,
      client_name: client.clientName,
      redirect_uri: redirectUri,
      scope: requested.length ? requested.join(" ") : "admin",
      state: raw.state,
      code_challenge: challenge,
    },
  };
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(verifier) as BufferSource);
  return bytesToBase64Url(new Uint8Array(digest));
}

/* ------------------------------------------------------------------ http */

function oauthError(c: Context<AppEnv>, status: 400 | 401 | 403, error: string, description: string) {
  return c.json({ error, error_description: description }, status);
}

/** The token endpoint is form-encoded per spec; some clients send JSON anyway. */
async function readForm(c: Context<AppEnv>): Promise<Record<string, string | undefined>> {
  const contentType = c.req.header("content-type") ?? "";
  const raw: unknown = contentType.includes("json")
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody().catch(() => ({}));

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------- consent */

const HIDDEN_FIELDS = ["client_id", "redirect_uri", "scope", "state", "code_challenge"] as const;

function loginPage(params: AuthorizeParams, error: string | null): string {
  const hidden = HIDDEN_FIELDS.map((key) =>
    params[key] ? `<input type="hidden" name="${key}" value="${esc(params[key]!)}">` : "",
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${esc(params.client_name)} — Open OTA</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --card: #ffffff; --fg: #16181d; --muted: #62676f;
    --line: #dfe2e7; --accent: #2f6feb; --accent-fg: #ffffff; --danger: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1014; --card: #171a21; --fg: #e9ebef; --muted: #9aa1ab;
      --line: #2a2f39; --accent: #4d86ff; --accent-fg: #0e1014; --danger: #ff8a80;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: var(--bg); color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--line);
         border-radius: 12px; padding: 28px; }
  h1 { margin: 0 0 6px; font-size: 19px; }
  p.sub { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
  label { display: block; margin-bottom: 14px; font-size: 13px; color: var(--muted); }
  input[type=email], input[type=password] {
    display: block; width: 100%; margin-top: 6px; padding: 10px 12px; font: inherit;
    color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { width: 100%; margin-top: 8px; padding: 11px; font: inherit; font-weight: 600;
           color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
  .error { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
           color: var(--danger); border: 1px solid var(--danger); }
  .scope { margin: 18px 0 0; padding-top: 16px; border-top: 1px solid var(--line);
           color: var(--muted); font-size: 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
  <h1>Connect ${esc(params.client_name)}</h1>
  <p class="sub">Sign in to let it manage your Open OTA releases.</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ""}
  <form method="post" action="authorize">
    ${hidden}
    <label>Email
      <input type="email" name="email" autocomplete="username" required autofocus>
    </label>
    <label>Password
      <input type="password" name="password" autocomplete="current-password" required>
    </label>
    <button type="submit">Sign in and connect</button>
  </form>
  <p class="scope">Scope <code>${esc(params.scope)}</code> · redirects to <code>${esc(params.redirect_uri)}</code></p>
</main>
</body>
</html>`;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}
