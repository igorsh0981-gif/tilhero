import type { StaffTicketSummary, TicketStatus } from "@tilhero/contracts/admin";

export type LiveSla = "over" | "soon" | "ok" | "paused" | "met";
export const SOON_MS = 30 * 60_000;

/**
 * Live SLA state from the server snapshot (sla_due_at / sla_paused / sla_state) and the local clock: the
 * countdown ticks every second without refetching; a «soon» from the server (its own threshold) is kept.
 */
export function liveSla(tk: Pick<StaffTicketSummary, "status" | "sla_due_at" | "sla_paused" | "sla_state" | "sla_target">, now: number): { state: LiveSla; left: number | null } {
  if (tk.status === "RESOLVED" || tk.status === "CLOSED" || !tk.sla_target) return { state: "met", left: null };
  if (tk.sla_paused || tk.status === "WAITING_CUSTOMER") return { state: "paused", left: null };
  if (!tk.sla_due_at) return { state: "met", left: null };
  const due = new Date(tk.sla_due_at).getTime();
  if (Number.isNaN(due)) return { state: "met", left: null };
  const left = due - now;
  const state: LiveSla = left < 0 ? "over" : left < SOON_MS || tk.sla_state === "soon" ? "soon" : "ok";
  return { state, left };
}

const RANK: Record<LiveSla, number> = { over: 0, soon: 1, ok: 2, paused: 3, met: 4 };

/** Queue order: overdue first, then the nearest deadline, then the oldest. */
export function sortQueue<T extends StaffTicketSummary>(items: readonly T[], now: number): T[] {
  return [...items].sort((a, b) => {
    const sa = liveSla(a, now);
    const sb = liveSla(b, now);
    const d = RANK[sa.state] - RANK[sb.state];
    if (d) return d;
    if (sa.left != null && sb.left != null && sa.left !== sb.left) return sa.left - sb.left;
    return a.created_at.localeCompare(b.created_at);
  });
}

/** Transitions available to an operator by PATCH (support-service STAFF_TRANSITIONS). */
export const STAFF_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  NEW: ["IN_PROGRESS"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "RESOLVED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "RESOLVED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: [],
};
export const TICKET_STATUSES: readonly TicketStatus[] = ["NEW", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"];
export const CATEGORIES = ["EVENT_RECOMMENDATION", "TICKET_SOURCE", "FLIGHT", "HOTEL", "PRICE", "SUBSCRIPTION_PAYMENT", "ACCOUNT", "PERSONAL_DATA", "BUG", "OTHER"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
