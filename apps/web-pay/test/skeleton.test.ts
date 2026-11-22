/**
 * Каркас сайта оплаты (поток 0): заголовки Caddy по INTERNAL_API §3 и отсутствие сторонних скриптов в index.html.
 * Тест ответа Caddy (заголовки на живом процессе) и Playwright — поток H.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const caddy = readFileSync(resolve(root, "Caddyfile"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");

describe("web-pay: каркас", () => {
  it("CSP и заголовки безопасности — как INTERNAL_API §3", () => {
    expect(caddy).toContain(
      `Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"`,
    );
    expect(caddy).toContain('Strict-Transport-Security "max-age=31536000"');
    expect(caddy).toContain('Referrer-Policy "no-referrer"');
    expect(caddy).toContain('X-Content-Type-Options "nosniff"');
    expect(caddy).toContain('Cross-Origin-Opener-Policy "same-origin"');
    expect(caddy).toMatch(/Permissions-Policy "[^"]*payment=\(\)/);
    expect(caddy).toMatch(/handle_path \/api\/\* \{[\s\S]*rewrite \* \/web\/v1\{uri\}/);
  });

  it("index.html: только свой модуль, без Telegram SDK и внешних адресов; no-referrer", () => {
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(["/src/main.tsx"]);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
  });
});
