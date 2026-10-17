/** Trade (exporters, importers, C&F agents): labels, money in any currency, and amounts in words.
 * Amounts travel as whole minor units of the file's currency (cents, paise); people type normal amounts. */

export const CURRENCIES = ["USD", "EUR", "GBP", "AED", "SAR", "QAR", "OMR", "KWD", "BHD", "SGD", "AUD", "CAD", "JPY", "CNY", "HKD", "MYR", "THB", "BDT", "LKR", "NPR", "CHF", "ZAR", "INR"] as const;
const DIGITS: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, IDR: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };
const CURRENCY_WORDS: Record<string, [string, string]> = {
  USD: ["US Dollars", "Cents"], EUR: ["Euros", "Cents"], GBP: ["Pounds Sterling", "Pence"], AED: ["UAE Dirhams", "Fils"],
  SAR: ["Saudi Riyals", "Halalas"], QAR: ["Qatari Riyals", "Dirhams"], OMR: ["Omani Rials", "Baisa"], KWD: ["Kuwaiti Dinars", "Fils"],
  BHD: ["Bahraini Dinars", "Fils"], SGD: ["Singapore Dollars", "Cents"], AUD: ["Australian Dollars", "Cents"],
  CAD: ["Canadian Dollars", "Cents"], JPY: ["Japanese Yen", ""], CNY: ["Chinese Yuan", "Fen"], HKD: ["Hong Kong Dollars", "Cents"],
  MYR: ["Malaysian Ringgit", "Sen"], THB: ["Thai Baht", "Satang"], BDT: ["Bangladeshi Taka", "Poisha"], LKR: ["Sri Lankan Rupees", "Cents"],
  NPR: ["Nepalese Rupees", "Paisa"], CHF: ["Swiss Francs", "Rappen"], ZAR: ["South African Rand", "Cents"], INR: ["Rupees", "Paise"],
};

export const INCOTERMS = ["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"] as const;
export const MODES: Record<string, string> = { sea: "Sea", air: "Air", road: "Road", rail: "Rail", courier: "Courier" };
export const TERMS: Record<string, string> = {
  advance: "Advance",
  lc: "Letter of credit (LC)",
  dp: "Documents against payment (D/P)",
  da: "Documents against acceptance (D/A)",
  cad: "Cash against documents (CAD)",
  open: "Open account",
  other: "Other",
};
export const DOC_STATUS: Record<string, string> = { needed: "Needed", received: "Received", done: "Done", not_needed: "Not needed" };
export const ROLE_LABEL: Record<string, string> = { exporter: "Exporter", importer: "Importer", cha: "C&F / customs broker" };

export type FileKind = "export" | "import" | "job_export" | "job_import";
export const FILE_KINDS: Record<FileKind, { label: string; hint: string; direction: "export" | "import"; for_client: boolean; party: string; role: string }> = {
  export: { label: "Our export", hint: "Goods we sell abroad", direction: "export", for_client: false, party: "Buyer", role: "exporter" },
  import: { label: "Our import", hint: "Goods we buy from abroad", direction: "import", for_client: false, party: "Supplier", role: "importer" },
  job_export: { label: "Client's export (C&F job)", hint: "Clearing a client's export", direction: "export", for_client: true, party: "Client", role: "cha" },
  job_import: { label: "Client's import (C&F job)", hint: "Clearing a client's import", direction: "import", for_client: true, party: "Client", role: "cha" },
};

export function fileKind(direction: string, forClient: boolean): FileKind {
  return (forClient ? `job_${direction}` : direction) as FileKind;
}

export function partyLabel(direction: string, forClient: boolean): string {
  return FILE_KINDS[fileKind(direction, forClient)].party;
}

export function digits(currency: string): number {
  return DIGITS[currency] ?? 2;
}

/** "12,500.50" → minor units of `currency`, or null when it isn't an amount. */
export function toMinor(input: string, currency: string): number | null {
  const d = digits(currency);
  const s = input.trim().replace(/^[A-Z]{3}\s*/i, "").replace(/[,\s$€£₹]/g, "");
  const re = d ? new RegExp(`^\\d+(\\.\\d{0,${d}})?$`) : /^\d+$/;
  if (!re.test(s)) return null;
  const [w, f = ""] = s.split(".");
  const v = Number(w) * 10 ** d + Number((f + "000").slice(0, d) || 0);
  return Number.isSafeInteger(v) ? v : null;
}

export function minorToInput(minor: number | null | undefined, currency: string): string {
  if (!minor) return "";
  const d = digits(currency);
  const w = Math.floor(minor / 10 ** d);
  const f = minor % 10 ** d;
  return f ? `${w}.${String(f).padStart(d, "0").replace(/0+$/, "")}` : String(w);
}

export function money(minor: number | null | undefined, currency: string): string {
  const d = digits(currency);
  const v = (minor ?? 0) / 10 ** d;
  return `${currency} ${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
  "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ""}`);
  return parts.join(" ");
}

/** International system (thousand, million, billion): 1234567 → "One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven". */
export function numberToWords(n: number): string {
  if (n === 0) return "Zero";
  const scales = ["", "Thousand", "Million", "Billion", "Trillion"];
  const out: string[] = [];
  let i = 0;
  let x = Math.floor(n);
  while (x > 0 && i < scales.length) {
    const chunk = x % 1000;
    if (chunk) out.unshift(`${below1000(chunk)}${scales[i] ? ` ${scales[i]}` : ""}`);
    x = Math.floor(x / 1000);
    i += 1;
  }
  return out.join(" ");
}

/** 1234550 USD → "US Dollars Twelve Thousand Three Hundred Forty-Five and Cents Fifty Only". */
export function amountInWords(minor: number, currency: string): string {
  const d = digits(currency);
  const [major, sub] = CURRENCY_WORDS[currency] ?? [currency, "Cents"];
  const whole = Math.floor(minor / 10 ** d);
  const frac = minor % 10 ** d;
  return `${major} ${numberToWords(whole)}${frac && sub ? ` and ${sub} ${numberToWords(frac)}` : ""} Only`;
}

export function kg(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 3 })} kg`;
}

export function stageTone(stage: string): "neutral" | "accent" | "success" | "info" {
  if (stage === "closed" || stage === "paid" || stage === "delivered") return "success";
  if (stage === "cancelled") return "neutral";
  if (stage === "shipped" || stage === "arrived" || stage === "cleared") return "info";
  return "accent";
}

