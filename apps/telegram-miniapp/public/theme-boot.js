/* TilHero: the explicit theme choice (Profile → «Тема») before the first paint — no flash of the wrong notebook.
   A classic blocking script (CSP: script-src 'self', no inline scripts). Reads only the localStorage copy written by
   src/tg/theme.ts (key "tilhero:theme_pref"); «Как в Telegram» and the CloudStorage copy are applied by the app. */
(function () {
  try {
    var v = window.localStorage.getItem("tilhero:theme_pref");
    if (v === "light" || v === "dark") {
      var r = document.documentElement;
      r.setAttribute("data-scheme", v);
      r.setAttribute("data-theme", v === "dark" ? "notebook_dark" : "notebook");
      r.setAttribute("data-theme-pref", v);
    }
  } catch (e) {
    /* storage unavailable: the app applies the theme */
  }
})();
