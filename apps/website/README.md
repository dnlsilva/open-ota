# open-ota.dev

The project website: a custom landing page plus the documentation, built with Astro and Starlight. Everything is static output.

```bash
pnpm --filter @open-ota/website dev      # local, http://localhost:4321
pnpm --filter @open-ota/website build    # → apps/website/dist
```

## Deploying to Cloudflare Pages

Connect the repository in the Cloudflare dashboard (Workers & Pages → Create → Pages) with:

| Setting | Value |
|---|---|
| Build command | `pnpm --filter @open-ota/website build` |
| Build output directory | `apps/website/dist` |
| Root directory | `/` (the repo root — the build needs the workspace) |
| Environment | `NODE_VERSION=22` |

Then attach the `open-ota.dev` custom domain to the Pages project. Every push to `main` redeploys.

The docs live in `src/content/docs/` as plain Markdown; the sidebar is defined in `astro.config.mjs`. The landing page is `src/pages/index.astro` and deliberately ships a single dark theme so the product screenshots sit in it natively — the docs have both themes.

Screenshots under `public/` are copies of `docs/images/` in the repo root, captured from the demo server (`pnpm --filter @open-ota/server demo`), not mockups.
