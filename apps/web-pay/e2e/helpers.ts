/**
 * Общая обвязка e2e: mock BFF, сбор нарушений CSP (securitypolicyviolation + console «Refused to …»), запросов вне
 * своего origin и адресов главного фрейма (проверка «в URL нет ПДн»).
 */
import { expect, type Page } from "@playwright/test";
import { MockBff, PROVIDER_HOSTS, type Scenario } from "./fixtures/mock-bff";

export interface Watch {
  bff: MockBff;
  cspViolations: string[];
  consoleErrors: string[];
  foreignRequests: string[];
  navigations: string[];
}

export async function setup(page: Page, scenario: Scenario = {}): Promise<Watch> {
  const bff = await new MockBff(scenario).install(page);
  const w: Watch = { bff, cspViolations: [], consoleErrors: [], foreignRequests: [], navigations: [] };
  await page.exposeFunction("__cspViolation", (d: string) => w.cspViolations.push(d));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __cspViolation: (d: string) => void }).__cspViolation(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on("console", (m) => {
    if (m.type() === "error") w.consoleErrors.push(m.text());
  });
  page.on("request", (r) => {
    const u = new URL(r.url());
    const own = u.hostname === "127.0.0.1";
    const provider = PROVIDER_HOSTS.includes(u.hostname) && r.isNavigationRequest();
    if (!own && !provider && u.protocol !== "data:") w.foreignRequests.push(r.url());
  });
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) w.navigations.push(f.url());
  });
  return w;
}

/** Нет нарушений CSP и запросов к сторонним адресам (шрифты, аналитика, SDK). */
export function expectClean(w: Watch): void {
  expect(w.cspViolations, "CSP violations").toEqual([]);
  expect(w.consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e)), "CSP console").toEqual([]);
  expect(w.foreignRequests, "requests to foreign origins").toEqual([]);
}

/** Адреса сайта: только «/», /buy/<код>, /orders, /orders/<номер>; query — только код ошибки входа (без ПДн). */
export function expectCleanUrls(w: Watch): void {
  for (const raw of w.navigations) {
    const u = new URL(raw);
    if (u.hostname !== "127.0.0.1") continue; // страница провайдера (заглушка)
    expect(u.pathname, raw).toMatch(/^\/(buy\/[a-z0-9_]+|orders(\/\d+)?)?$/);
    expect(u.search, raw).toMatch(/^(\?login_error=(auth_failed|account_not_found|not_allowed))?$/);
  }
}

/** Текущий адрес сайта без query (после очистки). */
export async function expectAddress(page: Page, path: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(path);
}
