import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** Builds the module path of a QR code locally (no external QR service: the TOTP secret never leaves the page). */
export function qrPath(data: string): { size: number; d: string } {
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return { size: n, d };
}

export function Qr({ data, label }: { data: string; label: string }) {
  const { size, d } = useMemo(() => qrPath(data), [data]);
  const m = 2;
  return (
    <svg className="qr" viewBox={`${-m} ${-m} ${size + 2 * m} ${size + 2 * m}`} role="img" aria-label={label} shapeRendering="crispEdges" data-testid="mfa-qr">
      <rect className="bg" x={-m} y={-m} width={size + 2 * m} height={size + 2 * m} />
      <path className="m qr-mod" d={d} />
    </svg>
  );
}
