import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/theme.default.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/tables.css";
import "./styles/screens.css";
import "./styles/content.css";
import { App } from "./App";
import { I18nProvider, normLang, type Lang } from "./i18n";
import { prefs } from "./lib/storage";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { ToastProvider } from "./ui/toasts";

/** UI language: the viewer's saved choice → Russian (the working language of the admin team). The browser
 * language is not used: an English-language browser got the EN UI and then Chrome machine-translated it into a
 * mix of languages ("Регистрация персонала", "Sign in"). EN stays one click away in the header. */
function initialLang(): Lang {
  return normLang(prefs.get<string | null>("lang", null)) ?? "ru";
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <I18nProvider initial={initialLang()} onChange={(l) => prefs.set("lang", l)}>
        <ErrorBoundary scope="app">
          <ToastProvider>
            <App />
          </ToastProvider>
        </ErrorBoundary>
      </I18nProvider>
    </StrictMode>,
  );
}
