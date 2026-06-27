import { fileURLToPath, URL } from "node:url";

import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const backendUrl = process.env.ANOMALO_BACKEND_URL || "http://127.0.0.1:8000";

export default defineConfig({
  root: "frontend",
  base: "/",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./frontend/src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": backendUrl,
      "/health": backendUrl,
      "/static": backendUrl,
      "/fonts": backendUrl,
      "/ws": {
        target: backendUrl,
        ws: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  build: {
    outDir: "../app/frontend",
    emptyOutDir: true,
    sourcemap: false,
  },
});
