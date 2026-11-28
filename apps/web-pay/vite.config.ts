import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Сайт оплаты (спринт 8, INTERNAL_API §3). Приложение ходит только на относительный /api/* (один origin, cookie
// __Host-wp_session). В production Caddy проксирует /api/* → telegram-bff /web/v1/* по приватной сети; в `vite dev`
// тот же префикс уходит на WEB_PAY_BFF_DEV_URL (по умолчанию http://127.0.0.1:8001). В бандле нет секретов и адресов.
const bff = process.env.WEB_PAY_BFF_DEV_URL ?? "http://127.0.0.1:8001";

/** Заголовки безопасности из Caddyfile (блок `header { … }`) — `vite preview` отдаёт сборку с той же CSP, что и prod:
 *  Playwright проверяет сайт под настоящей политикой (встроенные скрипты и стили, внешние адреса — нарушение). */
export function caddyHeaders(caddyfile: string): Record<string, string> {
  const block = /\n\theader \{\n([\s\S]*?)\n\t\}/.exec(caddyfile)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/^\t\t([A-Za-z-]+) "([^"]*)"$/gm)) out[m[1]!] = m[2]!;
  return out;
}

const securityHeaders = caddyHeaders(readFileSync(new URL("./Caddyfile", import.meta.url), "utf8"));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    host: true,
    proxy: { "/api": { target: bff, changeOrigin: false, xfwd: true, rewrite: (p) => p.replace(/^\/api/, "/web/v1") } },
  },
  // HSTS по http://127.0.0.1 браузер всё равно не применяет; прочее — как в prod
  preview: { port: 4175, strictPort: true, headers: securityHeaders },
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
