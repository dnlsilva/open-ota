// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://open-ota.dev",
  integrations: [
    starlight({
      title: "Open OTA",
      description:
        "Self-hosted over-the-air updates for React Native and Expo — signed releases, gradual rollout, automatic rollback and adoption metrics.",
      customCss: ["./src/styles/theme.css"],
      social: {
        github: "https://github.com/dnlsilva/open-ota",
      },
      editLink: {
        baseUrl: "https://github.com/dnlsilva/open-ota/edit/main/apps/website/",
      },
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quick start", slug: "getting-started/quick-start" },
            { label: "Try it without an app", slug: "getting-started/demo" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Publishing releases", slug: "guides/publishing" },
            { label: "Channels and promotion", slug: "guides/channels" },
            { label: "Gradual rollout", slug: "guides/rollout" },
            { label: "Rollback", slug: "guides/rollback" },
            { label: "Preview on a device", slug: "guides/preview" },
            { label: "Telemetry and metrics", slug: "guides/telemetry" },
            { label: "Native compatibility", slug: "guides/native-compatibility" },
          ],
        },
        {
          label: "SDK",
          items: [
            { label: "Installation (Expo)", slug: "sdk/installation" },
            { label: "Bare React Native", slug: "sdk/bare-react-native" },
            { label: "JavaScript API", slug: "sdk/api" },
            { label: "How updates apply", slug: "sdk/how-updates-apply" },
          ],
        },
        {
          label: "Server",
          items: [
            { label: "Self-host with Docker", slug: "server/docker" },
            { label: "Deploy to Supabase", slug: "server/supabase" },
            { label: "Deploy to Cloudflare", slug: "server/cloudflare" },
            { label: "Configuration", slug: "server/configuration" },
            { label: "Hosted mode", slug: "server/hosted-mode" },
          ],
        },
        {
          label: "CLI",
          items: [{ label: "Command reference", slug: "cli/reference" }],
        },
        {
          label: "MCP",
          items: [
            { label: "Connect an agent", slug: "mcp/connect" },
            { label: "Tool reference", slug: "mcp/tools" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Update protocol", slug: "reference/update-protocol" },
            { label: "Security model", slug: "reference/security" },
            { label: "Telemetry costs", slug: "reference/telemetry-costs" },
            { label: "Known limitations", slug: "reference/limitations" },
          ],
        },
      ],
    }),
  ],
});
