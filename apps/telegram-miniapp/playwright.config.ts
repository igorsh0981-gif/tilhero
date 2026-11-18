import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, defineConfig, devices } from "@playwright/test";

/**
 * e2e against the Vite dev server outside Telegram (dev fallback: VITE_DEV_INIT_DATA; in-app back button) with a mock
 * BFF via page.route (e2e/fixtures/mock-bff.ts). Main viewport — 390×844 (prototype); browsers from
 * PLAYWRIGHT_BROWSERS_PATH (CI image: /opt/pw-browsers).
 */
const PORT = Number(process.env.E2E_PORT ?? 5181);
const DEV_INIT_DATA =
  "query_id=AAE2e&user=%7B%22id%22%3A918273645%2C%22first_name%22%3A%22Aziz%22%2C%22language_code%22%3A%22ru%22%7D&auth_date=1791370000&hash=e2e";

/**
 * The Chromium of this @playwright/test version, or — when the image ships another build (sandbox: /opt/pw-browsers
 * with a newer headless shell) — that one. PLAYWRIGHT_CHROMIUM_EXECUTABLE overrides both.
 */
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
    viewport: { width: 390, height: 844 },
    colorScheme: "light",
    locale: "ru-RU",
    timezoneId: "Asia/Tashkent",
    hasTouch: true,
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
    launchOptions: { executablePath: chromiumExecutable() },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { VITE_BFF_URL: "/__bff", VITE_DEV_INIT_DATA: DEV_INIT_DATA, VITE_BOT_USERNAME: "TilHeroBot" },
  },
});
