---
title: Connect an agent
description: Point an MCP client at the remote /mcp endpoint over OAuth, or run the tools locally over stdio.
---

There are two transports and one tool contract. Remote is a route on the
server; local is a subcommand of the CLI. Both expose the same fifteen tools —
see the [tool reference](/mcp/tools/).

## Remote, over HTTP

```bash
claude mcp add --transport http ota https://your-server/mcp
```

A browser opens, you sign in, and the client is connected. Nothing is installed
and no token is pasted. Any MCP client that speaks Streamable HTTP and OAuth
connects the same way.

The endpoint is available on every install, self-hosted or hosted. It requires
`PUBLIC_URL` to be the address clients actually type, because the discovery
documents are built from it.

### What happens

1. The client `POST`s to `/mcp` with no credentials. The server answers **401**
   with a `WWW-Authenticate: Bearer resource_metadata="…"` header pointing at
   `/.well-known/oauth-protected-resource`. That pointer is what makes a client
   start the flow by itself instead of just failing.
2. The client reads that document — it names the resource, the authorization
   server, and the `admin` and `read` scopes — then
   `/.well-known/oauth-authorization-server` for the endpoints.
3. **Dynamic client registration**: `POST /oauth/register` with a client name
   and its redirect URIs. The server returns a `client_id`, no secret, and
   `token_endpoint_auth_method: "none"`. A CLI or desktop agent cannot keep a
   secret, so PKCE is the proof of possession instead.
4. **PKCE, mandatory**: `GET /oauth/authorize` requires
   `code_challenge_method=S256` and a base64url digest of 43 to 128 characters.
   Anything else is rejected. The `redirect_uri` must match one registered for
   that client exactly — never a prefix or an origin.
5. The browser shows a sign-in page. There is no session to reuse, because this
   server authenticates with Bearer tokens only, so consent always asks for the
   password. A wrong password re-renders the page rather than bouncing an OAuth
   error at the client.
6. On success the server issues an authorization code, valid **120 seconds**,
   and redirects.
7. `POST /oauth/token` exchanges it. The code is burned before anything else is
   validated, so it is single-use whether or not the exchange succeeds; then the
   client id, the redirect URI and the `code_verifier` are checked.
8. The response carries an access token valid **30 days** and a refresh token.
   Refreshing rotates: the old access token is deleted along with the refresh
   token that minted it.

Access tokens are ordinary `api_tokens` rows with `kind: "oauth"`. One token
system, one revocation path — revoking in settings kills an agent's access the
same way it kills a CI token.

### Without OAuth

Clients that do not implement the flow can send the header directly:

```bash
claude mcp add --transport http ota https://your-server/mcp \
  --header "Authorization: Bearer ota_..."
```

Create that token in the dashboard under the project's settings. A token scoped
to a single project also removes the need to pass `projectId` to every tool.

### Notes on the endpoint

`/mcp` accepts `POST` only; anything else answers 405 with a JSON-RPC error,
because nothing here streams and there is no session to delete. A server and
transport are built per request and torn down after it, which is the only shape
that works on an edge runtime where the next request may land in a different
isolate.

## Local, over stdio

```bash
ota mcp
```

The CLI runs the same tools against whatever API it is configured for, using
the credentials from `ota login`, or from the environment:

```json
{
  "mcpServers": {
    "ota": {
      "command": "npx",
      "args": ["@open-ota/cli", "mcp"],
      "env": {
        "OTA_API_URL": "https://ota.example.com",
        "OTA_TOKEN": "ota_..."
      }
    }
  }
}
```

`--project <id>` and `-c <channel>` set the defaults for tools that omit them;
without either, they come from `ota.config.json` in the working directory.
Nothing may write to stdout — that is the JSON-RPC channel — so the CLI's own
messages go to stderr.

Use stdio when you do not want to expose `/mcp`, when you are offline or in CI,
and when you want `publish_release` to build from a local directory.

## One surface, not two

The contract — tool name, description and argument schema — lives once in
`packages/shared/src/mcp.ts`. Neither transport declares its own; each binds
handlers to the shared shapes, the remote route against the service layer and
the CLI against the API client.

`apps/server/test/mcp-contract.test.ts` fails if they drift. Writing that test
is what surfaced real drift between the two implementations: different
descriptions for the same tool and, worse, incompatible arguments — an agent
connected over stdio passed `releaseId` where one connected over HTTP passed
`projectId` plus `release`.

A release is named the way a person says it: `v42` works anywhere a uuid does,
with `platform` and `channel` disambiguating when a label repeats.
