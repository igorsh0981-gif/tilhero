import { useI18n } from "../../i18n";
import { useApp } from "../../state/app";
import { useLoad } from "../../state/hooks";
import { Btn, ErrorLine, Pill, Skeleton } from "../../ui/kit";
import { showToast } from "../../ui/overlays";
import { Bar } from "../../ui/shell";

/** Profile → «Мои языки» (APP-LANG-01/02, AT-31): ru → en is active; other pairs of the directory are «скоро» and
 *  cannot be started. */
export function MyLanguages() {
  const { bff, nav } = useApp();
  const { t, l } = useI18n();
  const langs = useLoad(() => bff.languages(), []);
  return (
    <>
      <Bar title={t("langs.title")} onBack={nav.back} />
      <main className="scroll" data-testid="my-languages">
        <div className="pad stack">
          <p className="sub">{t("langs.text")}</p>
          {langs.loading && !langs.data ? (
            <Skeleton lines={3} />
          ) : langs.error && !langs.data ? (
            <div className="stack tight">
              <ErrorLine text={langs.error} />
              <Btn variant="secondary" onClick={() => void langs.reload()}>{t("c.retry")}</Btn>
            </div>
          ) : langs.data ? (
            <div className="list">
              {langs.data.pairs.map((p) =>
                p.available ? (
                  <div className="row" key={p.pair_id} data-testid={`pair-${p.pair_id}`}>
                    <span className="t">
                      <b>{l(p.title)}</b>
                      <span>{p.source.toUpperCase()} → {p.target.toUpperCase()}</span>
                    </span>
                    <Pill tone="ok">{t("langs.active")}</Pill>
                  </div>
                ) : (
                  <button type="button" className="row" key={p.pair_id} onClick={() => showToast(t("langs.soonToast"))} data-testid={`pair-${p.pair_id}`}>
                    <span className="t">
                      <b>{l(p.title)}</b>
                      <span>{p.source.toUpperCase()} → {p.target.toUpperCase()}</span>
                    </span>
                    <Pill tone="mute">{t("langs.soon")}</Pill>
                  </button>
                ),
              )}
            </div>
          ) : null}
        </div>
      </main>
    </>
  );
}
