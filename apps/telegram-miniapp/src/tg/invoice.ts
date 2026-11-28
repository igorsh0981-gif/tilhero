import type { TgInvoiceStatus } from "./types";
import { getWebApp, isInsideTelegram, supports } from "./webapp";

/**
 * Sprint 8 — payment for Telegram Stars inside the Mini App (APP-BILL-02, INTERNAL_API §1.5): the ONLY way the app opens a
 * payment is `Telegram.WebApp.openInvoice(invoice_link)` with the link the server got from Bot API createInvoiceLink.
 * There is no other way to pay in the Mini App and no link anywhere else (anti-steering, owner decision В1).
 *
 * The status of openInvoice is only a hint (paid / cancelled / failed / pending — not confirmed by the docs, §14 S5):
 * the order of the billing is the source of truth, the screen polls it after the invoice closes (domain/billing).
 *
 *  - only https://t.me/… links are opened (anything else — "invalid", nothing is opened);
 *  - outside Telegram or before Bot API 6.1 — "unsupported" (the screen says to update Telegram);
 *  - one invoice at a time: a second call while one is open resolves "busy" at once (a double tap never opens two).
 */
export type InvoiceOutcome = TgInvoiceStatus | "unsupported" | "invalid" | "busy";

const INVOICE_LINK = /^https:\/\/t\.me\/[A-Za-z0-9_$+\-/=]{1,512}$/;

export function isInvoiceLink(url: unknown): url is string {
  return typeof url === "string" && INVOICE_LINK.test(url);
}

/** openInvoice is there: inside Telegram with Bot API 6.1+. */
export function canOpenInvoice(): boolean {
  const wa = getWebApp();
  return !!wa && isInsideTelegram() && supports("6.1") && typeof wa.openInvoice === "function";
}

let open = false;

const STATUSES: ReadonlySet<string> = new Set(["paid", "cancelled", "failed", "pending"]);

export function openInvoice(url: string): Promise<InvoiceOutcome> {
  if (!isInvoiceLink(url)) return Promise.resolve("invalid");
  if (!canOpenInvoice()) return Promise.resolve("unsupported");
  if (open) return Promise.resolve("busy");
  const wa = getWebApp()!;
  return new Promise((resolve) => {
    open = true;
    const done = (status: unknown) => {
      if (!open) return;
      open = false;
      resolve(typeof status === "string" && STATUSES.has(status) ? (status as TgInvoiceStatus) : "pending");
    };
    try {
      wa.openInvoice!(url, done);
    } catch (e) {
      open = false;
      // another invoice or popup of Telegram is open: this one is dropped, never drawn twice
      resolve(e instanceof Error && /Opened/i.test(e.message) ? "busy" : "failed");
    }
  });
}

/** Tests only: forget an invoice that never closed. */
export function resetInvoiceForTests(): void {
  open = false;
}
