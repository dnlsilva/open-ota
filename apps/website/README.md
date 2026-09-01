# open-ota.dev

The project website: a custom landing page plus the documentation, built with Astro and Starlight. Everything is static output.

```bash
pnpm --filter @open-ota/website dev      # local, http://localhost:4321
pnpm --filter @open-ota/website build    # → apps/website/dist
```

## Deploying to Cloudflare

The site ships as an assets-only Worker described by `wrangler.jsonc` in this
directory. In the Cloudflare dashboard (Workers & Pages → the connected repo →
Settings → Build):

| Setting | Value |
|---|---|
| Build command | `pnpm --filter @open-ota/website build` |
| Deploy command | `npx wrangler deploy --config apps/website/wrangler.jsonc` |
| Root directory | `/` (the repo root — the build needs the workspace) |

A bare `npx wrangler deploy` fails here on purpose: the repo root is a
workspace and also contains the API server's own `wrangler.toml`, so the
config path has to be explicit. Attach the `open-ota.dev` custom domain to the
`open-ota-website` Worker. Every push to `main` redeploys.

The docs live in `src/content/docs/` as plain Markdown; the sidebar is defined in `astro.config.mjs`. The landing page is `src/pages/index.astro` and deliberately ships a single dark theme so the product screenshots sit in it natively — the docs have both themes.

Screenshots under `public/` are copies of `docs/images/` in the repo root, captured from the demo server (`pnpm --filter @open-ota/server demo`), not mockups.
