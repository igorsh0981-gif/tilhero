/**
 * Сайт оплаты TilHero (спринт 8, INTERNAL_API §3) — каркас потока 0; страницы пишет поток H.
 * Правила: без Telegram SDK, сторонних скриптов, шрифтов и аналитики (CSP Caddyfile); API — только относительный
 * /api/* (telegram-bff /web/v1/*); суммы — целые тийины из API, вывод «49 000 сум» / «49 000 soʻm» (U+02BB);
 * переход к провайдеру и к Telegram — навигацией страницы (location.assign), без всплывающих окон; в URL нет ПДн.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

export function App() {
  return <main>TilHero</main>;
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
