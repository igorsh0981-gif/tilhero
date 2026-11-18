import { useState } from "react";
import { Auth } from "../api/endpoints";
import { ApiError } from "../api/errors";
import { useI18n } from "../i18n";
import { PasswordFields } from "../screens/auth/PasswordFields";
import { useSession } from "../state/session";
import { Callout } from "../ui/kit";
import { Drawer } from "../ui/overlays";
import { useToast } from "../ui/toasts";
import { errText } from "../ui/errors";

/** Change own password inside the session (current password required; the other sessions are revoked). */
export function AccountDrawer({ onClose }: { onClose: () => void }) {
  const i = useI18n();
  const { t } = i;
  const { me, refreshMe } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const submit = async (pw: string, current: string) => {
    setBusy(true);
    try {
      await Auth.passwordChange(current, pw);
      toast(t("pwd.changedSession"), "ok");
      await refreshMe();
      onClose();
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.code === "INVALID_CREDENTIALS") return t("pwd.err.currentWrong");
      if (e instanceof ApiError && e.code === "PASSWORD_WEAK") return t("pwd.err.weak");
      return errText(i, e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer title={t("account.changePwd")} sub={<span className="mono">{me.staff.email}</span>} onClose={onClose} testId="account-drawer">
      <Callout kind="info" icon="key">
        {t("pwd.sessionNote")}
      </Callout>
      <PasswordFields email={me.staff.email} busy={busy} withCurrent onSubmit={submit} submitLabel={t("common.save")} />
    </Drawer>
  );
}
