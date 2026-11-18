import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Admin web build. The app talks to admin-bff only through relative /admin/v1/* (one origin, first-party
// cookie). In production Caddy proxies that prefix; in `vite dev` the same prefix is proxied to
// ADMIN_BFF_DEV_URL (default http://127.0.0.1:8002). Nothing secret is baked into the bundle.
const bff = process.env.ADMIN_BFF_DEV_URL ?? "http://127.0.0.1:8002";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    host: true,
    proxy: { "/admin/v1": { target: bff, changeOrigin: false, xfwd: true } },
  },
  preview: { port: 4174, strictPort: true },
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
