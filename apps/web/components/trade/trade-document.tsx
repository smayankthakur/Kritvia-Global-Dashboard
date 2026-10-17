"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { TERMS, amountInWords, kg, money } from "@/lib/trade";

type S = Schemas["ShipmentOut"];
type P = Schemas["TradeProfileOut"];

const DEFAULT_DECLARATION =
  "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.";

function Cell({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="border-b border-r border-black/20 p-1.5">
      <p className="text-[10px] font-semibold tracking-wide uppercase">{label}</p>
      <p className="min-h-4 whitespace-pre-line">{value || "—"}</p>
    </div>
  );
}

/** An export invoice or packing list laid out for paper: Print, or Save as PDF from the print dialog. */
export function TradeDocument({ s, p, kind }: { s: S; p: P | null; kind: "invoice" | "packing" }) {
  const inv = kind === "invoice";
  const docDate = s.docs.find((d) => d.code === (inv ? "commercial_invoice" : "packing_list"))?.ref_date ?? new Date().toISOString().slice(0, 10);
  const total = s.value_minor + s.freight_minor + s.insurance_minor;
  const pieces = s.packages.reduce((t, x) => t + x.count, 0);
  const net = s.packages.reduce((t, x) => t + Number(x.net_kg ?? 0), 0);
  const gross = s.packages.reduce((t, x) => t + Number(x.gross_kg ?? 0), 0);
  const marks = s.packages.map((x) => x.marks).filter(Boolean).join("\n");
  const exporter = [p?.legal_name, p?.address, p?.iec ? `IEC: ${p.iec}` : null, p?.gstin ? `GSTIN: ${p.gstin}` : null, p?.ad_code ? `AD code: ${p.ad_code}` : null, [p?.email, p?.phone].filter(Boolean).join(" · ") || null]
    .filter(Boolean)
    .join("\n");
  const buyer = [s.party_name, s.party_address, s.party_country ? `Country: ${s.party_country}` : null, [s.party_email, s.party_phone].filter(Boolean).join(" · ") || null].filter(Boolean).join("\n");

  return (
    <div className="mx-auto max-w-4xl bg-white p-6 text-[12px] text-black print:max-w-none print:p-0">
      <div className="mb-4 flex justify-end gap-2 print:hidden">
        <Button icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      {!p?.configured ? <p className="mb-3 rounded border border-black/30 p-2 print:hidden">Add your trade profile (IEC, address, AD code, bank) so it prints here.</p> : null}
      <h1 className="mb-2 text-center text-lg font-bold tracking-wide">{inv ? "EXPORT INVOICE" : "PACKING LIST"}</h1>
      <div className="grid grid-cols-2 border-t border-l border-black/20">
        <Cell label="Exporter" value={exporter} />
        <div className="grid grid-cols-2">
          <Cell label={inv ? "Invoice no." : "Packing list no."} value={s.number} />
          <Cell label="Date" value={formatDate(docDate)} />
          <Cell label="Buyer's order no." value={s.reference} />
          <Cell label="Other references" value={s.customs_no ? `SB ${s.customs_no}` : null} />
        </div>
        <Cell label="Consignee / buyer" value={buyer} />
        <Cell label="Notify party / consignee (if other than buyer)" value={s.other_party} />
        <div className="grid grid-cols-2">
          <Cell label="Mode" value={s.mode.toUpperCase()} />
          <Cell label={s.mode === "air" ? "Flight" : "Vessel / voyage"} value={s.vessel} />
          <Cell label="Port of loading" value={s.port_loading} />
          <Cell label="Port of discharge" value={s.port_discharge} />
        </div>
        <div className="grid grid-cols-2">
          <Cell label="Country of origin of goods" value="India" />
          <Cell label="Country of final destination" value={s.party_country} />
          <Cell label="Final destination" value={s.final_destination} />
          <Cell label="Terms of delivery and payment" value={[s.incoterm ? `${s.incoterm}${s.incoterm_place ? ` ${s.incoterm_place}` : ""}` : null, s.payment_terms ? TERMS[s.payment_terms] : null, s.payment_terms === "lc" && s.lc_no ? `LC ${s.lc_no}` : null].filter(Boolean).join("\n")} />
        </div>
      </div>

      {inv ? (
        <table className="mt-3 w-full border-collapse text-left">
          <thead>
            <tr className="border-y border-black/40 text-[11px]">
              <th className="p-1.5">Marks & nos.</th>
              <th className="p-1.5">Description of goods</th>
              <th className="p-1.5">HS code</th>
              <th className="p-1.5 text-right">Quantity</th>
              <th className="p-1.5 text-right">Rate ({s.currency})</th>
              <th className="p-1.5 text-right">Amount ({s.currency})</th>
            </tr>
          </thead>
          <tbody>
            {s.items.map((it, i) => (
              <tr key={i} className="border-b border-black/10 align-top">
                <td className="p-1.5 whitespace-pre-line">{i === 0 ? marks || "—" : ""}</td>
                <td className="p-1.5">{it.description}</td>
                <td className="p-1.5">{it.hs_code ?? "—"}</td>
                <td className="p-1.5 text-right tabular-nums">
                  {Number(it.qty).toLocaleString("en-IN", { maximumFractionDigits: 3 })} {it.unit ?? ""}
                </td>
                <td className="p-1.5 text-right tabular-nums">{money(it.unit_price_minor, s.currency).replace(`${s.currency} `, "")}</td>
                <td className="p-1.5 text-right tabular-nums">{money(it.amount_minor, s.currency).replace(`${s.currency} `, "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="mt-3 w-full border-collapse text-left">
          <thead>
            <tr className="border-y border-black/40 text-[11px]">
              <th className="p-1.5">Marks & nos.</th>
              <th className="p-1.5">No. and kind of packages</th>
              <th className="p-1.5">Contents</th>
              <th className="p-1.5 text-right">Net weight</th>
              <th className="p-1.5 text-right">Gross weight</th>
              <th className="p-1.5">Dimensions</th>
            </tr>
          </thead>
          <tbody>
            {s.packages.map((x, i) => (
              <tr key={i} className="border-b border-black/10 align-top">
                <td className="p-1.5">{x.marks ?? "—"}</td>
                <td className="p-1.5">
                  {x.count} {x.kind}
                </td>
                <td className="p-1.5">{x.contents ?? "—"}</td>
                <td className="p-1.5 text-right tabular-nums">{kg(x.net_kg)}</td>
                <td className="p-1.5 text-right tabular-nums">{kg(x.gross_kg)}</td>
                <td className="p-1.5">{x.dimensions ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="mt-3 flex flex-wrap justify-between gap-6">
        <div className="max-w-md space-y-1.5">
          <p>
            <strong>Packages:</strong> {pieces || "—"} · <strong>Net:</strong> {kg(net)} · <strong>Gross:</strong> {kg(gross)}
          </p>
          {s.containers ? (
            <p>
              <strong>Container(s):</strong> {s.containers}
            </p>
          ) : null}
          {inv ? (
            <p>
              <strong>Amount in words:</strong> {amountInWords(total, s.currency)}
            </p>
          ) : null}
        </div>
        {inv ? (
          <dl className="ml-auto grid min-w-60 grid-cols-[1fr_auto] gap-x-6 gap-y-1">
            <dt>{s.freight_minor || s.insurance_minor ? "FOB value" : "Total value"}</dt>
            <dd className="text-right tabular-nums">{money(s.value_minor, s.currency)}</dd>
            {s.freight_minor ? (
              <>
                <dt>Freight</dt>
                <dd className="text-right tabular-nums">{money(s.freight_minor, s.currency)}</dd>
              </>
            ) : null}
            {s.insurance_minor ? (
              <>
                <dt>Insurance</dt>
                <dd className="text-right tabular-nums">{money(s.insurance_minor, s.currency)}</dd>
              </>
            ) : null}
            <dt className="border-t border-black/40 pt-1 font-bold">Total {s.incoterm ?? ""}</dt>
            <dd className="border-t border-black/40 pt-1 text-right font-bold tabular-nums">{money(total, s.currency)}</dd>
          </dl>
        ) : null}
      </section>

      <footer className="mt-4 space-y-2 border-t border-black/20 pt-3 text-[11px]">
        {inv ? (
          <p className="font-semibold">
            {s.lut
              ? `Supply meant for export under LUT${p?.lut_arn ? ` (ARN ${p.lut_arn})` : ""} without payment of integrated tax (IGST).`
              : "Supply meant for export on payment of integrated tax (IGST)."}
          </p>
        ) : null}
        {inv && p?.bank_details ? (
          <p className="whitespace-pre-line">
            <strong>Bank details:</strong> {p.bank_details}
          </p>
        ) : null}
        <p>{p?.declaration || DEFAULT_DECLARATION}</p>
        <div className="flex justify-end pt-8">
          <div className="min-w-48 border-t border-black/40 pt-1 text-center">
            For {p?.legal_name ?? "the exporter"}
            <br />
            Authorised signatory
          </div>
        </div>
      </footer>
    </div>
  );
}
