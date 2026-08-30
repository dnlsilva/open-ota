# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
RUN npm install -g pnpm@11.1.2
WORKDIR /repo

# Manifests first: the install layer only rebuilds when a dependency changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY packages/react-native/package.json packages/react-native/
COPY examples/expo-demo/package.json examples/expo-demo/
RUN pnpm install --frozen-lockfile --filter "@open-ota/server..." --filter "@open-ota/dashboard..."

COPY . .
RUN pnpm --filter @open-ota/dashboard build && pnpm --filter @open-ota/server build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production DASHBOARD_DIR=/app/dashboard PORT=3000
WORKDIR /app

# The server build is a single self-contained bundle, so no node_modules ship
# here. Keep the dist/entry depth: the bundle resolves ../../drizzle at boot.
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
COPY --from=build /repo/apps/dashboard/dist ./dashboard

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/entry/node.js"]
