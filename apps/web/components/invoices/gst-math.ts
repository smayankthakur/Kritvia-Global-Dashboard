/** The same GST arithmetic as the server (services/gst.py), for the live totals while typing. */

export const GST_RATES = ["0", "0.1", "0.25", "1", "1.5", "3", "5", "6", "12", "18", "28", "40"] as const;

/** "1.5" → 1500n (thousandths); null when it isn't a quantity with up to 3 decimals. */
export function qtyMilli(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d{0,3})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  const v = BigInt(w!) * 1000n + BigInt((f + "000").slice(0, 3));
  return v > 0n ? v : null;
}

function rateHundredths(rate: string): bigint {
  const [w, f = ""] = rate.split(".");
  return BigInt(w!) * 100n + BigInt((f + "00").slice(0, 2));
}

/** n / d rounded half up (n, d >= 0). */
function div(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

export interface LineTax {
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export function lineTax(qty: string, ratePaise: number, discountPaise: number, gstRate: string, sameState: boolean): LineTax | null {
  const q = qtyMilli(qty);
  if (q === null) return null;
  const gross = div(q * BigInt(ratePaise), 1000n);
  const taxable = gross - BigInt(discountPaise) > 0n ? gross - BigInt(discountPaise) : 0n;
  const r = rateHundredths(gstRate);
  if (sameState) {
    const half = Number(div(taxable * r, 20000n));
    return { taxable: Number(taxable), cgst: half, sgst: half, igst: 0 };
  }
  return { taxable: Number(taxable), cgst: 0, sgst: 0, igst: Number(div(taxable * r, 10000n)) };
}
