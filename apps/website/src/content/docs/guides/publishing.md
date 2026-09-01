---
title: Publishing releases
description: What ota publish does between your source tree and a signed release devices can install.
---

`ota publish` turns the current working tree into one release per platform. It runs the export, hashes the result, uploads it straight to storage, and asks the server to sign it.

```bash
ota publish --channel production --rollout 10
```

## The five steps

1. **Export.** For each platform (`all` by default) the CLI runs `expo export --platform ios --output-dir <tmpdir> --clear`, preferring `node_modules/.bin/expo` over `npx`. Pass `--bundle-dir` to skip this and publish an export you already have.
2. **Zip, deterministically.** The export directory is archived exactly as Expo produced it — nested bundle under `_expo/static/js`, hashed files under `assets/`, and `metadata.json` naming both. Entries are sorted by byte order, every entry gets a fixed mtime (1980-01-01) and mode `0644`, and no directory entries are written. The same export therefore always produces the same bytes, which matters because the digest of this zip is what the server signs and the device verifies. A timestamp leaking in would make every republish look like new content.
3. **Hash locally.** SHA-256 of the archive, computed on your machine.
4. **Upload.** `POST /releases/prepare-upload` with the digest, size, platform, channel and runtime version. The server inserts the release row as `pending`, assigns the next label, and hands back a signed upload target. The CLI `PUT`s the bytes at that URL directly. Nothing about the bundle passes through the API.
5. **Confirm.** `POST /releases/confirm`. The server `HEAD`s the object, rejects a size mismatch, re-hashes the bytes where reads are cheap, signs the manifest with the project's private key, and flips the row to `active`. Only then can a device be offered it.

## Why bundles never cross the API

A 50 MB `PUT` through the API would pin a request for its whole duration, which is exactly what an edge runtime cannot afford — the same server has to run inside a Supabase Edge Function and a Cloudflare Worker. Keeping the transfer between the CLI and the bucket means the API only ever moves a few kilobytes of JSON, and the storage adapter (R2, S3, MinIO, Supabase Storage) is free to issue whatever credential it prefers.

The digest is the reason this is safe: the server never trusts the uploaded bytes, it verifies them against the digest you declared before signing anything.

## One publish, one group

Every invocation mints a single `groupId` (a UUIDv7) shared by the iOS and Android releases it produces. Same JavaScript, two platforms, one logical release — which is how the dashboard groups them and how you reason about a rollout that covers both.

Labels do not follow the group. A label is the next integer within one project, channel and platform, computed inside the insert statement so two concurrent publishes cannot collide. `v42` on `staging` and `v42` on `production` are different releases, and promoting a release gives it a new label in its destination — see [Channels and promotion](/guides/channels/).

## Flags

| Flag | Effect |
|---|---|
| `-c, --channel <name>` | Channel to publish to. Defaults to the channel in `ota.config.json`, otherwise `production`. Unknown channels are created. |
| `-p, --platform <p>` | `ios`, `android` or `all`. Default `all`. |
| `--rollout <percent>` | Whole number 0–100. Default 100. See [Gradual rollout](/guides/rollout/). |
| `--mandatory` | The device reloads as soon as the download finishes instead of waiting for the next launch. |
| `-m, --message <text>` | Release note, stored on the release and shown in the dashboard. |
| `--bundle-dir <dir>` | Publish a prebuilt export. Accepts `dist/ios` and `dist/android`, or a single directory used for both. |
| `--project <id>` | Override the configured project id. |
| `--dry-run` | Export and hash, upload nothing. |
| `--json` | Print the result as JSON on stdout instead of a table. |

The git commit of the working tree is attached automatically when the project is a git repository.

## What it prints

Progress goes to stderr, the table and JSON go to stdout, so `--json` pipes cleanly.

```
› expo export (ios)
› Zipping ios bundle from /var/folders/t2/ota-export-ios-Ku9xVb
  214 files · 4.8 MB · b94d27b9934d
› Publishing ios to production
› expo export (android)
› Zipping android bundle from /var/folders/t2/ota-export-android-Qp1s7c
  214 files · 4.8 MB · 7d1f0a3c81ee
› Publishing android to production

LABEL  RELEASE                               PLATFORM    SIZE  SHA256        CHANNEL     ROLLOUT
v42    0198f3a2-6c41-7e19-9a30-2b7c5d1e4f80  ios       4.8 MB  b94d27b9934d  production      10%
v42    0198f3a2-6c41-7e19-9a30-2b7c5d1e4f81  android   4.8 MB  7d1f0a3c81ee  production      10%

✔ Published to production · runtime fp_9c1b3e… · group 0198f3a2-6c41-7e1a-…
Devices pick it up on their next update-check.
```

`--dry-run` prints the same table with `—` in place of the label, release id and rollout, and ends with `Dry run — nothing was uploaded.`

## Failure modes worth knowing

- **No `fingerprint.json`.** Publishing stamps the committed fingerprint, never a freshly computed one, so the CLI stops and tells you to run `ota fingerprint`. See [Native compatibility](/guides/native-compatibility/).
- **Bundle over 200 MB.** Refused by the CLI before the upload and by the server on `prepare-upload`.
- **Upload rejected.** Signed URLs expire. The message says so; run the publish again.
- **Digest mismatch on confirm.** The object is deleted and the release stays `pending`, which means no device is ever offered it.

:::note
A `pending` release is a row with no usable bundle. It is never returned by an update-check, and the only status change it accepts is `disabled`.
:::
