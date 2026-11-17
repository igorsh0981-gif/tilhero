/**
 * Brand fonts without blocking the first frame (review 🟡-11). index.html only preconnects and preloads the
 * Google Fonts CSS; the stylesheet is attached here, after the app script starts, so the WebView paints at once
 * with the metric-matched "<Brand> Fallback" faces (ui-tokens base.css) and swaps in the brand fonts
 * (`display=swap` → font-display: swap). No inline handlers: the CSP stays `script-src 'self'`.
 */
export const BRAND_FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Unbounded:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap";

export function loadBrandFonts(doc: Document = document): HTMLLinkElement {
  const existing = doc.querySelector<HTMLLinkElement>("link[data-brand-fonts]");
  if (existing) return existing;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = BRAND_FONTS_CSS;
  link.dataset.brandFonts = "";
  doc.head.appendChild(link);
  return link;
}
