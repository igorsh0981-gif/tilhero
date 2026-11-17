import type { GeoOption, InterestCategory, PolicyDocument } from "@tilhero/contracts/bff";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useApp, useErrorText } from "../state/app";
import { geoOptionKey, MAX_GEOGRAPHIES, toggleGeo, type PrefDraft } from "../state/prefs";
import { Icon } from "../ui/Icon";
import { Chip, Note, Spinner } from "../ui/kit";
import { Markdown } from "../ui/Markdown";
import { Sheet } from "../ui/overlays";

/** GET /v1/legal/policy?lang= — rendered as safe Markdown. */
export function PolicySheet({ version, onClose }: { version: string; onClose: () => void }) {
  const { api } = useApp();
  const { t, lang } = useI18n();
  const errText = useErrorText();
  const [doc, setDoc] = useState<PolicyDocument | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setErr(null);
    api.legal.policy(lang).then(
      (d) => alive && setDoc(d),
      (e) => alive && setErr(e),
    );
    return () => {
      alive = false;
    };
  }, [api, lang, n]);
  return (
    <Sheet title={t("ob.c.policy", { v: doc?.version ?? version })} onClose={onClose}>
      {doc ? (
        <Markdown text={doc.text} />
      ) : err ? (
        <Note tone="bad" icon="alert" action={{ label: t("common.retry"), onClick: () => setN((x) => x + 1) }}>
          {errText(err)}
        </Note>
      ) : (
        <div className="empty">
          <Spinner />
        </div>
      )}
    </Sheet>
  );
}

/** All interest categories when the onboarding grid shows only the first 12. */
export function InterestsMoreSheet(props: { items: InterestCategory[]; draft: PrefDraft; setDraft: (fn: (d: PrefDraft) => PrefDraft) => void; onClose: () => void }) {
  const { t, l } = useI18n();
  return (
    <Sheet title={t("pref.interests")} onClose={props.onClose}>
      <div className="pref-ed">
        <div className="ob-grid" role="group" aria-label={t("pref.interests")}>
          {props.items.map((c) => (
            <Chip
              key={c.code}
              pressed={props.draft.interests.includes(c.code)}
              onToggle={() =>
                props.setDraft((x) => ({ ...x, interests: x.interests.includes(c.code) ? x.interests.filter((k) => k !== c.code) : [...x.interests, c.code] }))
              }
            >
              {l(c.label)}
            </Chip>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/** Case- and diacritic-insensitive: "turk" matches "Türkiye", Cyrillic yo equals ye. */
function norm(v: string): string {
  return v.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\u0451/g, "\u0435");
}

/** All countries and regions with search, when the onboarding step shows only the compact set. */
export function GeoMoreSheet(props: { items: GeoOption[]; draft: PrefDraft; setDraft: (fn: (d: PrefDraft) => PrefDraft) => void; onClose: () => void }) {
  const { t, l } = useI18n();
  const [q, setQ] = useState("");
  const ql = norm(q.trim());
  const list = props.items.filter((g) => !ql || norm(g.label.ru).includes(ql) || norm(g.label.en).includes(ql));
  const full = props.draft.geo.filter((k) => k !== "world").length >= MAX_GEOGRAPHIES;
  return (
    <Sheet title={t("pref.geo")} onClose={props.onClose}>
      <div className="pref-ed">
        <div className="field mb6">
          <Icon name="search" size={18} />
          <input
            id="geoIn"
            autoComplete="off"
            maxLength={30}
            value={q}
            onChange={(e) => setQ(e.target.value.slice(0, 30))}
            placeholder={t("pref.geo.search")}
            aria-label={t("pref.geo.search")}
            enterKeyHint="search"
          />
        </div>
        {full ? <Note icon="info">{t("pref.geo.max", { n: MAX_GEOGRAPHIES })}</Note> : null}
        <div className="ob-grid" role="group" aria-label={t("pref.geo")}>
          {list.map((g) => {
            const key = geoOptionKey(g);
            return (
              <Chip key={key} pressed={props.draft.geo.includes(key)} onToggle={() => props.setDraft((x) => toggleGeo(x, key))}>
                {l(g.label)}
              </Chip>
            );
          })}
        </div>
        {list.length === 0 ? <p className="dir-empty">{t("pref.geo.none", { q: q.trim() })}</p> : null}
      </div>
    </Sheet>
  );
}
