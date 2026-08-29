import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      // Default API base is the current origin, so proxying /api is all the
      // dev server needs to run the SPA against a local `apps/server`.
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
