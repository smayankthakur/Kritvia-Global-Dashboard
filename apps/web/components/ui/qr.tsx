import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** A QR code drawn as one SVG path (no injected markup). */
export function QrCode({ value, size = 220, label }: { value: string; size?: number; label: string }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let path = "";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) path += `M${c + 2} ${r + 2}h1v1h-1z`;
      }
    }
    return { n: count + 4, d: path };
  }, [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" className="rounded-md bg-white">
      <rect width={n} height={n} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
