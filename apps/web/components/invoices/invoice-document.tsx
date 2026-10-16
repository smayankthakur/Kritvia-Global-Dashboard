"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { rupees } from "./money";

type Doc = Schemas["InvoiceDocument"];

function Party({ label, p }: { label: string; p: Doc["supplier"] }) {
  return (
    <div className="space-y-0.5 text-sm">
      <p className="text-xs font-semibold tracking-wide text-subtle uppercase">{label}</p>
      <p className="font-semibold">{p.name}</p>
      {p.trade_name ? <p>{p.trade_name}</p> : null}
      {p.address ? <p className="whitespace-pre-line">{p.address}</p> : null}
      {p.gstin ? <p>GSTIN: {p.gstin}</p> : null}
      {p.state ? (
        <p>
          State: {p.state} ({p.state_code})
        </p>
      ) : null}
      {p.email ? <p>{p.email}</p> : null}
      {p.phone ? <p>{p.phone}</p> : null}
    </div>
  );
}

/** An invoice laid out for paper: Print, or Save as PDF from the print dialog. */
export function InvoiceDocument({ doc }: { doc: Doc }) {
  const igst = doc.igst_paise > 0;
  const gst = doc.kind === "gst";
  return (
    <div className="mx-auto max-w-3xl bg-white p-6 text-[13px] text-black print:max-w-none print:p-0">
      <div className="mb-4 flex justify-end gap-2 print:hidden">
        <Button icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-black/20 pb-4">
        <Party label="From" p={doc.supplier} />
        <div className="text-right">
          <h1 className="text-2xl font-bold">{doc.title}</h1>
          <p>
            No. <strong>{doc.number || "—"}</strong>
          </p>
          {doc.issued_on ? <p>Date: {formatDate(doc.issued_on)}</p> : null}
          <p>Due: {formatDate(doc.due_on)}</p>
          {gst ? <p>Reverse charge: {doc.reverse_charge ? "Yes" : "No"}</p> : null}
          {doc.status !== "open" ? <p className="mt-1 font-semibold uppercase">{doc.status}</p> : null}
        </div>
      </header>
      <section className="grid gap-4 border-b border-black/20 py-4 sm:grid-cols-2">
        <Party label="Bill to" p={doc.customer} />
        {doc.place_of_supply ? (
          <div className="text-sm sm:text-right">
            <p className="text-xs font-semibold tracking-wide text-subtle uppercase">Place of supply</p>
            <p>
              {doc.place_of_supply.name} ({doc.place_of_supply.code})
            </p>
          </div>
        ) : null}
      </section>
      {doc.items.length ? (
        <table className="mt-4 w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-black/30 text-xs">
              <th className="py-1.5 pr-2">#</th>
              <th className="py-1.5 pr-2">Description</th>
              <th className="py-1.5 pr-2">HSN/SAC</th>
              <th className="py-1.5 pr-2 text-right">Qty</th>
              <th className="py-1.5 pr-2 text-right">Rate</th>
              <th className="py-1.5 pr-2 text-right">Discount</th>
              <th className="py-1.5 pr-2 text-right">Taxable</th>
              <th className="py-1.5 pr-2 text-right">GST</th>
              <th className="py-1.5 text-right">Tax</th>
            </tr>
          </thead>
          <tbody>
            {doc.items.map((it) => (
              <tr key={it.position} className="border-b border-black/10 align-top">
                <td className="py-1.5 pr-2">{it.position}</td>
                <td className="py-1.5 pr-2">{it.description}</td>
                <td className="py-1.5 pr-2">{it.hsn_sac ?? "—"}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {it.qty} {it.unit ?? ""}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{rupees(it.rate_paise)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{it.discount_paise ? rupees(it.discount_paise) : "—"}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{rupees(it.taxable_paise)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{it.gst_rate}%</td>
                <td className="py-1.5 text-right tabular-nums">{rupees(it.cgst_paise + it.sgst_paise + it.igst_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <section className="mt-4 flex flex-wrap justify-between gap-6">
        <div className="max-w-sm space-y-2 text-sm">
          <p>
            <span className="text-xs font-semibold tracking-wide text-subtle uppercase">Amount in words</span>
            <br />
            {doc.amount_in_words}
          </p>
          {doc.tax_summary.length && gst ? (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-black/30">
                  <th className="py-1 pr-2 text-left">HSN/SAC</th>
                  <th className="py-1 pr-2 text-right">Rate</th>
                  <th className="py-1 pr-2 text-right">Taxable</th>
                  {igst ? <th className="py-1 text-right">IGST</th> : (
                    <>
                      <th className="py-1 pr-2 text-right">CGST</th>
                      <th className="py-1 text-right">SGST</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {doc.tax_summary.map((t) => (
                  <tr key={`${t.hsn_sac}-${t.gst_rate}`} className="border-b border-black/10">
                    <td className="py-1 pr-2">{t.hsn_sac ?? "—"}</td>
                    <td className="py-1 pr-2 text-right">{t.gst_rate}%</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{rupees(t.taxable_paise)}</td>
                    {igst ? <td className="py-1 text-right tabular-nums">{rupees(t.igst_paise)}</td> : (
                      <>
                        <td className="py-1 pr-2 text-right tabular-nums">{rupees(t.cgst_paise)}</td>
                        <td className="py-1 text-right tabular-nums">{rupees(t.sgst_paise)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
        <dl className="ml-auto grid min-w-56 grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
          {doc.taxable_paise !== null && doc.taxable_paise !== undefined ? (
            <>
              <dt>Taxable value</dt>
              <dd className="text-right tabular-nums">{rupees(doc.taxable_paise)}</dd>
            </>
          ) : null}
          {doc.cgst_paise ? (
            <>
              <dt>CGST</dt>
              <dd className="text-right tabular-nums">{rupees(doc.cgst_paise)}</dd>
              <dt>SGST</dt>
              <dd className="text-right tabular-nums">{rupees(doc.sgst_paise)}</dd>
            </>
          ) : null}
          {doc.igst_paise ? (
            <>
              <dt>IGST</dt>
              <dd className="text-right tabular-nums">{rupees(doc.igst_paise)}</dd>
            </>
          ) : null}
          <dt className="border-t border-black/30 pt-1 font-bold">Total</dt>
          <dd className="border-t border-black/30 pt-1 text-right font-bold tabular-nums">{rupees(doc.total_paise)}</dd>
          {doc.paid_paise ? (
            <>
              <dt>Paid</dt>
              <dd className="text-right tabular-nums">{rupees(doc.paid_paise)}</dd>
              <dt className="font-semibold">Balance</dt>
              <dd className="text-right font-semibold tabular-nums">{rupees(doc.balance_paise)}</dd>
            </>
          ) : null}
        </dl>
      </section>
      <footer className="mt-6 space-y-2 border-t border-black/20 pt-3 text-xs">
        {doc.terms ? <p className="whitespace-pre-line">{doc.terms}</p> : null}
        {doc.notes ? <p className="whitespace-pre-line">{doc.notes}</p> : null}
        {doc.status === "open" && doc.balance_paise > 0 ? <p>Pay online: {doc.pay_url}</p> : null}
        {gst ? (
          <div className="flex justify-end pt-8">
            <div className="min-w-48 border-t border-black/40 pt-1 text-center">
              For {doc.supplier.name}
              <br />
              Authorised signatory
            </div>
          </div>
        ) : null}
      </footer>
    </div>
  );
}
