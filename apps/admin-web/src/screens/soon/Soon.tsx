import { useI18n } from "../../i18n";
import { navItem, type PageId } from "../../state/nav";
import { Empty } from "../../ui/kit";

export type SoonPage = Extract<PageId, "content" | "agents" | "qa" | "costs" | "heroes" | "game" | "events" | "langs">;

/** Section of a later sprint: listed in the menu, an honest empty screen with the sprint number — no invented data. */
export function Soon({ page, sprint }: { page: PageId; sprint: number }) {
  const { t } = useI18n();
  const p = page as SoonPage;
  return (
    <section className="panel" data-testid="soon">
      <Empty icon={navItem(page)?.icon ?? "clock"} className="soon-page" title={t("soon.title", { page: t(`page.${p}`) })} text={t("soon.text", { n: sprint })}>
        <span className="soon-tag e-tag" data-testid="soon-sprint">
          {t("soon.tag", { n: sprint })}
        </span>
        <ul>
          <li>{t(`soon.${p}.1`)}</li>
          <li>{t(`soon.${p}.2`)}</li>
        </ul>
      </Empty>
    </section>
  );
}
