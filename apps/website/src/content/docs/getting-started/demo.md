---
title: Try it without an app
description: A full server with a week of seeded traffic, on an in-process Postgres — no Docker, no phone.
---

You do not need an app, a bucket or Docker to see what operating Open OTA feels like. The repo ships a demo server that runs the real server code on an embedded Postgres, pre-seeded with a believable week: six releases across two platforms, 4,200 devices, a healthy adoption curve — and one Android release with a 6.2% rollback rate, because the interesting screens are the ones with a problem on them.

```bash
git clone https://github.com/dnlsilva/open-ota && cd open-ota
pnpm install
pnpm --filter @open-ota/server demo
```

```
  Open OTA demo server on http://localhost:3000
  sign in with  demo@open-ota.dev / demo-password-1234
  project       Acme Delivery
  api token     ota_…
```

Then, in a second terminal:

```bash
pnpm --filter @open-ota/dashboard dev
```

Open the printed URL and sign in. Everything in the dashboard is live against the demo data: the version distribution table, the adoption chart, the funnel on each release, the rollout slider, pause and disable, the troubled release with its red rollback rate.

Two things worth knowing about how the demo is built:

- **It is the production code path, not a mock.** The same routers, the same services, the same SQL — the only substitutions are an in-process Postgres ([PGlite](https://pglite.dev)) and an in-memory bundle store. The seeded releases go through the real publish flow, digests and signatures included.
- **It is deterministic.** The random generator is seeded, so every run produces the same fleet and the same numbers. If you are poking at dashboard code, your data does not shift under you.

The printed API token works against everything: the [CLI](/cli/reference/) (`OTA_API_URL=http://localhost:3000 OTA_TOKEN=… ota releases`), the [Admin API](/reference/update-protocol/) directly, or an [MCP client](/mcp/connect/) pointed at the demo server.
