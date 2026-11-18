/** Sprint 9, SEC-11: a link from API data reaches `<a href>` only as an absolute http(s) URL — never `javascript:`,
 *  `data:` or a relative path. Returns the normalised href or null (render plain text instead). */
export function webHref(u: string | null | undefined): string | null {
  if (!u || u.length > 2048) return null;
  try {
    const url = new URL(u);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/** Sprint 9 review: the «Runbook» link of an alert only inside the runbook section (`Me.runbook_base_url` from admin-bff,
 *  the same RUNBOOK_BASE_URL as ops-monitor / notifications / bot-gateway): https, the same host, the normalised path
 *  under the section path, no query, no encoded dots or slashes. Without a base (older admin-bff) — https only. */
export function runbookHref(u: string | null | undefined, base: string | null | undefined): string | null {
  if (!u || u.length > 300 || !/^https:\/\//.test(u) || /[\s\\]|%(2e|2f|5c|25|00)/i.test(u)) return null;
  if (!base) return u;
  try {
    const url = new URL(u);
    const b = new URL(base);
    const basePath = b.pathname.endsWith("/") ? b.pathname : `${b.pathname}/`;
    if (url.protocol !== "https:" || url.host !== b.host || url.username || url.password || url.search) return null;
    return url.pathname.startsWith(basePath) && url.pathname.length > basePath.length ? url.href : null;
  } catch {
    return null;
  }
}
