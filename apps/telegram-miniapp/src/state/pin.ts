/**
 * PIN rules (decision 07.10.2026: 4 or 6 digits, optional) and the keypad flow reducer
 * shared by the PIN sheet (set / change / off / reset) and the lock screen.
 */
export type PinLength = 4 | 6;

export function isWeakPin(pin: string): boolean {
  if (!/^\d+$/.test(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true; // 0000, 111111
  const d = pin.split("").map(Number);
  const asc = d.every((v, i) => i === 0 || v === (d[i - 1]! + 1) % 10);
  const desc = d.every((v, i) => i === 0 || v === (d[i - 1]! + 9) % 10);
  if (asc || desc) return true; // 1234, 4321, 789012
  if (d.length >= 4 && d.length % 2 === 0) {
    const half = pin.slice(0, 2);
    if (pin === half.repeat(d.length / 2)) return true; // 1212, 121212
  }
  return false;
}

export type PinFormatError = "length" | "digits" | "weak";
export function pinFormatError(pin: string, len: PinLength): PinFormatError | null {
  if (!/^\d*$/.test(pin)) return "digits";
  if (pin.length !== len) return "length";
  if (isWeakPin(pin)) return "weak";
  return null;
}

export type PinMode = "set" | "change" | "off" | "reset" | "unlock";
export type PinStage = "cur" | "code" | "new" | "rep";

export interface PinFlow {
  mode: PinMode;
  stage: PinStage;
  /** length of the PIN being created */
  len: PinLength;
  /** length of the existing PIN (cur stage) */
  curLen: PinLength;
  entry: string;
  first: string;
  current: string;
  code: string;
  err: string | null;
  info: string | null;
  shake: boolean;
  busy: boolean;
}

export type PinAction =
  | { type: "digit"; d: string }
  | { type: "erase" }
  | { type: "len"; len: PinLength }
  | { type: "busy"; on: boolean }
  | { type: "advance"; stage: PinStage; patch?: Partial<Pick<PinFlow, "current" | "code" | "first" | "mode" | "info" | "err">> }
  | { type: "fail"; err: string }
  | { type: "settle" }
  /** 429 (review of sprint 9): not a wrong PIN — dots back to empty, no error shake; the wait text is the screen's */
  | { type: "neutral" }
  | { type: "info"; info: string | null; err?: string | null };

export function initialPinFlow(mode: PinMode, curLen: PinLength | null): PinFlow {
  const stage: PinStage = mode === "set" ? "new" : mode === "reset" ? "code" : "cur";
  return { mode, stage, len: 4, curLen: curLen ?? 4, entry: "", first: "", current: "", code: "", err: null, info: null, shake: false, busy: false };
}

/** digits expected at the current stage */
export function pinNeed(s: PinFlow): number {
  return s.stage === "cur" ? s.curLen : s.stage === "code" ? 6 : s.len;
}

export const pinFull = (s: PinFlow): boolean => s.entry.length === pinNeed(s);

export function pinReducer(s: PinFlow, a: PinAction): PinFlow {
  switch (a.type) {
    case "digit":
      if (s.busy || s.shake || !/^\d$/.test(a.d) || s.entry.length >= pinNeed(s)) return s;
      return { ...s, entry: s.entry + a.d, err: s.entry.length === 0 ? null : s.err };
    case "erase":
      if (s.busy || s.shake) return s;
      return { ...s, entry: s.entry.slice(0, -1) };
    case "len":
      if (s.stage !== "new") return s;
      return { ...s, len: a.len, entry: "", err: null };
    case "busy":
      return { ...s, busy: a.on };
    case "advance":
      return { ...s, ...a.patch, stage: a.stage, entry: "", busy: false, shake: false, err: a.patch?.err ?? null, info: a.patch?.info ?? null };
    case "fail":
      return { ...s, err: a.err, info: null, shake: true, busy: false };
    case "settle":
      return { ...s, shake: false, entry: "" };
    case "neutral":
      return { ...s, entry: "", shake: false, busy: false, err: null, info: null };
    case "info":
      return { ...s, info: a.info, err: a.err === undefined ? s.err : a.err };
    default:
      return s;
  }
}
