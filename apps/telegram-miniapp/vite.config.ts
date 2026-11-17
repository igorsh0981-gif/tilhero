import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Mini App build. Env (build time): VITE_BFF_URL, VITE_BOT_USERNAME, VITE_DEV_INIT_DATA (dev only).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, host: true },
  preview: { port: 4173, strictPort: true },
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
