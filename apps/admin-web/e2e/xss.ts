import { expect, type Page } from "@playwright/test";

/* Sprint 9, SEC-11: hostile strings in API data must render as text — no script runs, no markup or javascript: link
   appears. The same helper lives in apps/telegram-miniapp/e2e/xss.ts. */

export const PAYLOADS = [
  `<img src=x onerror="window.__xss=1">`,
  `<svg/onload=window.__xss=2>`,
  `"'><script>window.__xss=3</script>`,
  `<a href="javascript:window.__xss=4">клик</a>`,
  `<iframe srcdoc="<script>parent.__xss=5</script>"></iframe>`,
  `{{constructor.constructor('window.__xss=6')()}}`,
] as const;
export const JS_URL = "javascript:window.__xss=7";

/** Free-text fields that people or providers write (titles, names, messages, reasons): the payload is appended, the
 *  original prefix stays, so screens keep their logic. Enum-like fields (status, codes, ids) are left alone. */
const TEXT = /^(title|subject|summary|text|body|message|reason|description|venue|venue_name|place|city|display_name|first_name|last_name|username|note|last_message|comment|change_note|reason_class|event_type|preview|snippet|question|answer|headline|lead|source_name|author_name|name_ru|name_en|event_title)$/;
/** Link fields: replaced with a javascript: URL — it must never reach an <a href>. */
const LINK = /^(url|source_url|link|href|article_url|ticket_url|official_url|buy_url|site_url)$/;

/** `extra.text` / `extra.link` — more keys for one screen (e.g. feed `name`, `feed_url`); `links: false` keeps links
 *  (a screen that drops items with a non-http link would otherwise show nothing to check the text on). */
export function poison(data: unknown, extra: { text?: RegExp; link?: RegExp; links?: boolean } = {}): unknown {
  let n = 0;
  const isText = (k: string) => TEXT.test(k) || !!extra.text?.test(k);
  const isLink = (k: string) => extra.links !== false && (LINK.test(k) || !!extra.link?.test(k));
  const walk = (v: unknown, key: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === "string" && v && isText(key)) return `${v} ${PAYLOADS[n++ % PAYLOADS.length]}`;
    if (typeof v === "string" && isLink(key)) return JS_URL;
    return v;
  };
  return walk(data, "");
}

/** Collects dialogs (alert/confirm from an injected script). */
export function watchDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (d) => {
    seen.push(d.message());
    void d.dismiss();
  });
  return seen;
}

/** No payload executed or became markup on the current screen; the hostile data reached it (shown as text, or with
 *  tags stripped by the screen's own plain-text rendering). */
export async function expectInert(page: Page, dialogs: string[], where: string): Promise<void> {
  await page.waitForTimeout(400); // onerror of <img src=x> fires asynchronously
  const r = await page.evaluate(() => {
    const all = [...document.querySelectorAll("*")];
    const handlers = all.flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name) && /__xss/.test(a.value)).map((a) => `${el.tagName}[${a.name}]`));
    const jsLinks = [...document.querySelectorAll("a[href], area[href], iframe[src], form[action]")]
      .map((el) => el.getAttribute("href") ?? el.getAttribute("src") ?? el.getAttribute("action") ?? "")
      .filter((h) => /^\s*javascript:/i.test(h));
    const scripts = [...document.querySelectorAll("script")].filter((s) => /__xss/.test(s.textContent ?? "")).length;
    const frames = [...document.querySelectorAll("iframe[srcdoc]")].length;
    const text = document.body.innerText;
    return { xss: (window as unknown as { __xss?: unknown }).__xss ?? null, handlers, jsLinks, scripts, frames, shown: text.includes("__xss") };
  });
  expect(r.xss, `${where}: window.__xss`).toBeNull();
  expect(dialogs, `${where}: dialogs`).toEqual([]);
  expect(r.handlers, `${where}: on* handlers from data`).toEqual([]);
  expect(r.jsLinks, `${where}: javascript: links`).toEqual([]);
  expect(r.scripts, `${where}: injected <script>`).toBe(0);
  expect(r.frames, `${where}: injected <iframe srcdoc>`).toBe(0);
  expect(r.shown, `${where}: hostile data reached the screen`).toBe(true);
}
