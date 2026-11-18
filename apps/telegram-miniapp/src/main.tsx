import "@tilhero/ui-tokens/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { env } from "./env";
import { loadBrandFonts } from "./fonts";
import { I18nProvider, resolveLang } from "./i18n";
import { getWebApp, resolveBoot } from "./tg";

const boot = resolveBoot({
  wa: getWebApp(),
  isDev: env.isDev,
  devInitData: env.devInitData,
  search: window.location.search,
  navigatorLanguage: typeof navigator !== "undefined" ? navigator.language : null,
});

// brand fonts off the critical path (fallback faces paint the first frame)
loadBrandFonts();

// language before the profile arrives: initData language_code → ru (the profile locale wins later)
const initialLang = resolveLang(null, boot.languageCode);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider initial={initialLang}>
      <App boot={boot} />
    </I18nProvider>
  </StrictMode>,
);
