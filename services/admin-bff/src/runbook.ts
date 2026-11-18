/**
 * Ссылка «Runbook» оповещения (спринт 9, ревью): только внутри раздела `RUNBOOK_BASE_URL` — та же проверка, что
 * `tilhero_common.links.runbook_url_allowed` у notifications и bot-gateway (SEC9-06): https у обоих, тот же хост и порт
 * без userinfo; без пробелов, обратных слешей, управляющих символов, query и закодированных `.`/`/`/`\`/`%`; путь без
 * пустых сегментов и `.`/`..`, начинается с пути базы + `/`; фрагмент — якорь `[A-Za-z0-9_-]`.
 */
export const DEFAULT_RUNBOOK_BASE_URL = "https://github.com/igorsh0981-gif/tilhero/blob/main/docs/runbooks/";

const BAD_CHARS = /[\s\\\u0000-\u001f\u007f]/;
const ENCODED_TRAVERSAL = /%(2e|2f|5c|25|00)/i;
const FRAGMENT = /^[A-Za-z0-9_-]{0,128}$/;
const MAX_URL = 300;

function split(u: string): { scheme: string; netloc: string; path: string; query: string; fragment: string } | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(u);
  if (!m) return null;
  return { scheme: m[1]!.toLowerCase(), netloc: m[2]!, path: m[3] ?? "", query: m[4] ?? "", fragment: m[5] ?? "" };
}

export function runbookUrlAllowed(url: unknown, baseUrl: string): boolean {
  if (typeof url !== "string" || !url || url.length > MAX_URL) return false;
  if (BAD_CHARS.test(url) || ENCODED_TRAVERSAL.test(url) || url.includes("?")) return false;
  const u = split(url);
  const b = split(baseUrl);
  if (!u || !b || u.scheme !== "https" || b.scheme !== "https" || u.query) return false;
  if (u.netloc.includes("@") || b.netloc.includes("@") || !u.netloc || u.netloc.toLowerCase() !== b.netloc.toLowerCase()) return false;
  if (!FRAGMENT.test(u.fragment)) return false;
  let path: string;
  try {
    path = decodeURIComponent(u.path);
  } catch {
    return false;
  }
  if (path.includes("%")) return false;
  const segments = path.split("/").slice(1);
  if (!segments.length || segments.some((s) => s === "" || s === "." || s === "..")) return false;
  const basePath = b.path.endsWith("/") ? b.path : `${b.path}/`;
  return path.startsWith(basePath) && path.length > basePath.length;
}
