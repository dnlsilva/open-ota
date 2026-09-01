# expo-demo

A real Expo app wired to a local Open OTA server. It exists to prove the whole
loop end to end: publish from the CLI, see the release land on a device.

Expo Go will not work — the update mechanism lives in a native module, so this
needs a dev build (`expo run:ios` / `expo run:android`).

This app is **not** a workspace member: it pulls in the whole Expo toolchain,
which ships nothing and would dominate the repository's lockfile and dependency
reports. Install it on its own, from this directory:

```bash
pnpm install        # links @open-ota/react-native and the CLI from ../../packages
```

## 1. Start the backend

```bash
cd ../..
cp .env.example .env
```

Fill in `.env`:

```bash
openssl rand -base64 32        # -> OTA_MASTER_KEY
```

- `POSTGRES_PASSWORD`, `STORAGE_SECRET_KEY` — anything
- `OTA_ADMIN_EMAIL`, `OTA_ADMIN_PASSWORD` — created on first boot (10+ chars)
- `STORAGE_ENDPOINT=http://<your-lan-ip>:9000` — **not** `minio` and not
  `localhost`: presigned S3 URLs are signed for one hostname, and both the CLI
  and the phone have to reach the bucket at that exact address.

```bash
docker compose up -d --build
open http://localhost:3000          # dashboard
```

## 2. Create the project

```bash
cd examples/expo-demo
pnpm exec ota login --url http://<your-lan-ip>:3000   # email + password from .env
pnpm exec ota init                                    # creates the project, writes ota.config.json,
                                                      # fills the plugin entry in app.json
pnpm exec ota fingerprint                             # stamps the native compatibility hash
```

`ota init` overwrites the placeholder `apiUrl` and `projectId` in `app.json`.
Check that `apiUrl` is the LAN address, not `localhost` — the phone resolves
`localhost` to itself.

## 3. Build and run

```bash
pnpm prebuild
pnpm ios            # or: pnpm android
```

The app shows the running release (`embedded` until the first update lands), the
native version, the last update-check result and the native update state.

## 4. Publish

Change something visible in `App.tsx`, then:

```bash
pnpm exec ota publish -c production -m "first ota update"
```

Tap **Check for update** in the app, then **Reload**. The release label switches
from `embedded` to `v1`.

Useful next:

```bash
pnpm exec ota releases            # what is live on each channel
pnpm exec ota rollout <label> 10  # hand it to 10% of devices
pnpm exec ota rollback -c production
pnpm exec ota preview <label>     # QR code, opens that release on a device
```
