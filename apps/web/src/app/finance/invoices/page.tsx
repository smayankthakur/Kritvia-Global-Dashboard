"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  Company,
  Deal,
  Invoice,
  createInvoice,
  listCompanies,
  listDeals,
  listInvoices
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";
import { InvoiceStatus } from "../../../types/auth";

const statusFilters: InvoiceStatus[] = ["DRAFT", "SENT", "PAID", "OVERDUE"];

export default function FinanceInvoicesPage() {
  const { user, token, loading, error } = useAuthUser();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<InvoiceStatus | "">("");
  const [submitting, setSubmitting] = useState(false);

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [dealId, setDealId] = useState("");
  const [amount, setAmount] = useState("0");
  const [dueDate, setDueDate] = useState("");
  const [currency, setCurrency] = useState("INR");

  const canWrite = user?.role === "FINANCE" || user?.role === "ADMIN";

  const loadData = useCallback(async (): Promise<void> => {
    if (!token) {
      return;
    }
    try {
      setRequestError(null);
      const [invoiceRows, companyRows, dealRows] = await Promise.all([
        listInvoices(token, {
          status: selectedStatus || undefined,
          page,
          pageSize,
          sortBy: "dueDate",
          sortDir: "asc"
        }),
        listCompanies(token, { page: 1, pageSize: 100, sortBy: "name", sortDir: "asc" }),
        listDeals(token, { page: 1, pageSize: 100, sortBy: "createdAt", sortDir: "desc" })
      ]);
      setInvoices(invoiceRows.items);
      setTotal(invoiceRows.total);
      setCompanies(companyRows.items);
      setDeals(dealRows.items);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load invoices"
      );
    }
  }, [token, selectedStatus, page, pageSize]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    setPage(1);
  }, [selectedStatus]);

  const canGoPrev = page > 1;
  const canGoNext = page * pageSize < total;

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !canWrite) {
      return;
    }

    try {
      setSubmitting(true);
      await createInvoice(token, {
        invoiceNumber: invoiceNumber || undefined,
        companyId,
        dealId: dealId || undefined,
        amount: Number(amount),
        currency,
        dueDate
      });
      setInvoiceNumber("");
      setCompanyId("");
      setDealId("");
      setAmount("0");
      setDueDate("");
      await loadData();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to create invoice"
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }
  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }
  if (forbidden) {
    return (
      <AppShell user={user} title="Finance Invoices">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Finance Invoices">
      {requestError ? <p className="kv-error">{requestError}</p> : null}

      <div className="kv-row" style={{ marginBottom: "0.75rem" }}>
        <label htmlFor="invoice-status-filter">Status Filter: </label>
        <select
          id="invoice-status-filter"
          value={selectedStatus}
          onChange={(event) => setSelectedStatus(event.target.value as InvoiceStatus | "")}
        >
          <option value="">All</option>
          {statusFilters.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>

      <form onSubmit={onCreate} className="kv-form kv-card" style={{ maxWidth: "620px" }}>
        <h3 style={{ marginBottom: "0.25rem" }}>Create Invoice</h3>
        <input
          placeholder="Invoice # (optional)"
          value={invoiceNumber}
          onChange={(event) => setInvoiceNumber(event.target.value)}
          disabled={!canWrite}
        />
        <select
          value={companyId}
          onChange={(event) => setCompanyId(event.target.value)}
          required
          disabled={!canWrite}
        >
          <option value="">Select company</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
        <select
          value={dealId}
          onChange={(event) => setDealId(event.target.value)}
          disabled={!canWrite}
        >
          <option value="">No deal</option>
          {deals.map((deal) => (
            <option key={deal.id} value={deal.id}>
              {deal.title}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          step="0.01"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          required
          disabled={!canWrite}
        />
        <input value={currency} onChange={(event) => setCurrency(event.target.value)} disabled={!canWrite} />
        <input
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          required
          disabled={!canWrite}
        />
        <button type="submit" disabled={!canWrite || submitting} className="kv-btn-primary">
          {submitting ? "Creating..." : "Create Invoice"}
        </button>
      </form>

      <div className="kv-table-wrap" style={{ marginTop: "1rem" }}>
      <table>
        <thead>
          <tr>
            <th align="left">Invoice #</th>
            <th align="left">Company</th>
            <th align="left">Amount</th>
            <th align="left">Status</th>
            <th align="left">Due Date</th>
            <th align="left">Lock</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id}>
              <td>
                <Link href={`/finance/invoices/${invoice.id}`}>
                  {invoice.invoiceNumber ?? invoice.id.slice(0, 8)}
                </Link>
              </td>
              <td>{invoice.company?.name ?? "-"}</td>
              <td>
                {invoice.currency} {invoice.amount}
              </td>
              <td>{invoice.effectiveStatus}</td>
              <td>{new Date(invoice.dueDate).toLocaleDateString()}</td>
              <td>{invoice.isLocked ? "Locked" : "Unlocked"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="kv-pagination">
        <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={!canGoPrev}>
          Previous
        </button>
        <span>
          Page {page} of {Math.max(1, Math.ceil(total / pageSize))}
        </span>
        <button type="button" onClick={() => setPage((current) => current + 1)} disabled={!canGoNext}>
          Next
        </button>
      </div>
    </AppShell>
  );
}
