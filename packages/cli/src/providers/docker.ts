import type { Provider } from "./index.js";

/** Self-host: Node server + Postgres + MinIO (ARCHITECTURE §7). */
export const dockerProvider: Provider = {
  name: "docker",
  requires: [],
  steps: (context) => [
    {
      title: "Write docker-compose.yml",
      write: { path: "docker-compose.yml", contents: compose(context.bucket) },
    },
    {
      title: "Write .env.example",
      write: { path: ".env.example", contents: envExample(context.bucket, context.masterKey) },
    },
    {
      title: "Start the stack",
      command: ["docker", "compose", "up", "-d"],
      destructive: true,
      note: "Copy .env.example to .env first. Migrations run on server boot.",
    },
  ],
};

function compose(bucket: string): string {
  return `services:
  server:
    image: openota/server:latest
    depends_on: [postgres, minio]
    environment:
      DATABASE_URL: postgres://ota:\${POSTGRES_PASSWORD}@postgres:5432/ota
      OTA_MODE: self
      OTA_MASTER_KEY: \${OTA_MASTER_KEY}
      STORAGE_ENDPOINT: http://minio:9000
      STORAGE_BUCKET: ${bucket}
      STORAGE_ACCESS_KEY: \${STORAGE_ACCESS_KEY}
      STORAGE_SECRET_KEY: \${STORAGE_SECRET_KEY}
      PUBLIC_BUNDLE_BASE_URL: \${PUBLIC_BUNDLE_BASE_URL}
    ports: ["3000:3000"]
    restart: unless-stopped

  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: ota
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: ota
    volumes: [ota-postgres:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ota"]
      interval: 5s
    restart: unless-stopped

  # Drop this service when you point STORAGE_* at S3 or R2.
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: \${STORAGE_ACCESS_KEY}
      MINIO_ROOT_PASSWORD: \${STORAGE_SECRET_KEY}
    volumes: [ota-minio:/data]
    ports: ["9000:9000", "9001:9001"]
    restart: unless-stopped

volumes:
  ota-postgres:
  ota-minio:
`;
}

function envExample(bucket: string, masterKey: string): string {
  return `# Copy to .env. Bundles are immutable, so backups are pg_dump + the bucket.

POSTGRES_PASSWORD=change-me

# Encrypts every project's private signing key at rest. Lose it and you must
# re-key each project and ship new binaries. Generated for you:
OTA_MASTER_KEY=${masterKey}

STORAGE_BUCKET=${bucket}
STORAGE_ACCESS_KEY=ota-minio
STORAGE_SECRET_KEY=change-me-too

# Public, CDN-backed base url the devices download bundles from.
PUBLIC_BUNDLE_BASE_URL=http://localhost:9000/${bucket}
`;
}
