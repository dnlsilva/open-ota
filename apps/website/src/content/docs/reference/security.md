---
title: Security model
description: Keys, signing, the device verification order, the threat table, and how tokens and OAuth work.
---

## Keys

Every project gets its own **RSA-2048** key pair when it is created. The private
half never leaves the server, stored encrypted with **AES-256-GCM** under
`OTA_MASTER_KEY` in the format `base64(iv[12] || ciphertext || tag)`, and
decrypted in memory only to sign a manifest or a preview token. The public half
goes into `ota.config.json`, is committed, and is compiled into your binary.

Compromise is scoped: leaking one project's key does not touch another.

RSA rather than Ed25519 is a deliberate trade. Ed25519 is the better
cryptography, but it needs a third-party dependency on Android below API 33.
RSA-SHA256 verifies with platform APIs — `SecKey` on iOS, `java.security` on
Android — at every supported OS version, with nothing extra shipped.

## Signing

The manifest is serialised to **canonical JSON** — object keys sorted, no
insignificant whitespace, `undefined` dropped, arrays left in order — and signed
with RSASSA-PKCS1-v1_5 over SHA-256. The signature is detached and base64.
There is no JWT: envelope formats would mean a JWT parser on both native
platforms to wrap exactly the same bytes.

Verification re-serialises the received object rather than trusting the bytes
that arrived. If the device hashed the raw response text, any two encodings of
the same object would produce different digests, and worse, an attacker could
append fields the parser ignores but the signature was never computed over. Both
sides derive the signed bytes from the parsed value, so the only thing that can
verify is the exact object that was signed.

The `sha256` in the manifest comes from the CLI, which hashes locally before
uploading. The trust boundary is the admin token that authorised the publish —
a malicious publisher could publish malicious content with a correct hash
either way. The signature protects against tampering *after* publish. Where
re-reading a bundle is cheap, the server re-hashes it before activating the
release anyway.

## Device verification order

Native, before anything is used:

1. Rebuild the canonical JSON of the received manifest.
2. Verify the signature with the public key embedded at build time. On failure,
   discard and report `verifyFailed`.
3. Check `projectId`, `platform` and `runtimeVersion` against the binary.
4. Download the zip and check `sha256(zip) == manifest.sha256`. On failure,
   discard and report `verifyFailed`.
5. Only then extract and schedule it.

One artefact, one hash: the whole zip. Per-asset hashes only pay for themselves
with partial downloads or binary diffs.

## app_key is public by design

The Device API is authenticated by `x-ota-app-key`, which is compiled into every
copy of your app and therefore not a secret. It identifies a project; it
authorises nothing. All it permits is receiving signed content and posting
counters — and the server drops any release id in an event batch that does not
belong to that project, because those ids are untrusted input.

## Threats

| Threat | What stops it |
|---|---|
| Compromised storage or CDN, MITM, swapped URL | Signature and `sha256` are verified on the device. Unsigned code never runs; the worst outcome is bytes that fail the hash. |
| Replaying an old release (downgrade) | The server decides the target. `floor` blocks anything older than the JavaScript in the binary, and the manifest binds `runtimeVersion`. |
| A manifest from another project or app | `projectId` in the signed payload, plus a signature from that project's key. Another app's public key does not verify it. |
| Compromised server | Game over by definition — it holds the signing keys. Reduce the surface: master key in a secret manager, a small server, an audit log. |
| A leaked `app_key` | Public by design. It grants nothing beyond receiving signed content and posting counters. Rate limit by IP and device against metric pollution. |
| A device asking for `staging` without being a QA build | Accepted. Staging bundles are signed and are not secrets. If it matters, a `restricted` flag per channel with a per-channel key is the shape. |

## Preview tokens

A preview link carries a payload signed with the project's own key, which the
device already trusts:

```json
{"purpose":"preview","projectId":"…","releaseId":"…","exp":1756732500}
```

delivered as `myapp://ota/preview?d=<b64url payload>&s=<b64url signature>`.

Properties: knowing a release id is not enough, because the payload needs the
server's signature. `purpose` gives domain separation, so a preview token can
never be replayed as a manifest. It is bound to one project and one release, and
it expires — 15 minutes by default, 1 to 1440 configurable. The device tolerates
±300 seconds of clock skew; the server, which has no skew, validates `exp`
strictly, so a short expiry doubles as revocation. Replay inside the window is
accepted: the installable content is identical to what the rollout would deliver
and is authenticated the same way, so there is no privilege to escalate. The
token grants no access to the Admin API — the preview endpoint returns a
manifest and nothing else.

## Admin auth

Bearer tokens for everything: the dashboard, `ota console`, the CLI, CI and MCP.
Tokens are opaque `ota_…` strings, stored only as a SHA-256 hash, scoped to an
organisation and optionally a single project, carrying `admin` or `read`, and
revocable.

No cookies. A cookie would break `ota console` running locally against a remote
API — cross-domain CORS and `SameSite` — and would mean two auth paths to keep
correct across three runtimes. The trade is that a token in `localStorage` is
slightly weaker than an `httpOnly` cookie against XSS, accepted for a tool
behind a login.

Passwords use PBKDF2-HMAC-SHA256 at 600,000 iterations. Argon2 would need a
native module, which does not run on an edge runtime. The stored format carries
its own parameters, so raising the cost later is a migration rather than a
rewrite, and `login` rehashes on the way through.

## OAuth 2.1

The server is its own authorization server for remote MCP. PKCE with `S256` is
**mandatory** — no other challenge method is accepted, and the challenge must be
a base64url digest of 43 to 128 characters. Clients are public and hold no
secret; registration is dynamic and returns
`token_endpoint_auth_method: "none"`.

The `redirect_uri` must match one registered for that client **exactly** —
never a prefix or origin check, which is how authorization codes end up
delivered to the wrong place. Codes live 120 seconds and are burned before
anything else is validated, so they are single-use whether or not the exchange
succeeds. Access tokens last 30 days and are ordinary API token rows with kind
`oauth`; refresh rotates, deleting the access token that came with the refresh
token being spent. One token system, one revocation path.

## No filesystem in publish_release

The MCP `publish_release` tool has no filesystem branch on the server. Over HTTP
it accepts only a `releaseId` to confirm. Reading a caller-supplied path there
would hand every admin token a file-read primitive against the server's own
disk, returned as a published bundle — and a remote server has no access to your
files anyway. Building and uploading is the CLI's job. See
[the tool reference](/mcp/tools/).
