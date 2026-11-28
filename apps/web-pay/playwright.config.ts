import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, defineConfig, devices } from "@playwright/test";

/**
 * e2e сайта оплаты: production-сборка в `vite preview` с заголовками из Caddyfile (CSP как в prod — встроенные
 * скрипты и стили, внешние адреса блокируются браузером) и mock BFF через page.route (e2e/fixtures/mock-bff.ts) —
 * приложение ходит на тот же относительный /api/*, что и за Caddy. Браузеры: PLAYWRIGHT_BROWSERS_PATH
 * (образ CI: /opt/pw-browsers). Адаптивность — e2e/responsive.spec.ts (телефон, планшет, ПК).
 */
const PORT = Number(process.env.E2E_PORT ?? 5183);

/** Chromium этой версии @playwright/test или — если в образе другая сборка (/opt/pw-browsers) — она. */
function chromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* fall through */
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
    const exe = join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const executablePath = chromiumExecutable();

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
    locale: "ru-RU",
    timezoneId: "Asia/Tashkent",
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: `npx vite build --logLevel warn && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
