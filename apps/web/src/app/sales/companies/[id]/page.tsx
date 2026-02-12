"use client";

import { FormEvent, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AppShell } from "../../../../components/app-shell";
import {
  ApiError,
  Company,
  Contact,
  Deal,
  createContact,
  getCompany,
  listCompanyContacts,
  listDeals,
  updateCompany
} from "../../../../lib/api";
import { useAuthUser } from "../../../../lib/use-auth-user";

export default function SalesCompanyDetailPage() {
  const params = useParams<{ id: string }>();
  const { user, token, loading, error } = useAuthUser();
  const [company, setCompany] = useState<Company | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [savingCompany, setSavingCompany] = useState(false);

  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [addingContact, setAddingContact] = useState(false);

  async function loadData(currentToken: string, companyId: string): Promise<void> {
    try {
      setRequestError(null);
      const [companyRes, contactsRes, dealsRes] = await Promise.all([
        getCompany(currentToken, companyId),
        listCompanyContacts(currentToken, companyId),
        listDeals(currentToken, {
          companyId,
          page: 1,
          pageSize: 100,
          sortBy: "createdAt",
          sortDir: "desc"
        })
      ]);
      setCompany(companyRes);
      setIndustry(companyRes.industry ?? "");
      setWebsite(companyRes.website ?? "");
      setContacts(contactsRes);
      setDeals(dealsRes.items);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load company"
      );
    }
  }

  useEffect(() => {
    if (!token || !params.id) {
      return;
    }

    void loadData(token, params.id);
  }, [token, params.id]);

  async function onUpdateCompany(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !company) {
      return;
    }

    try {
      setSavingCompany(true);
      await updateCompany(token, company.id, {
        industry,
        website
      });
      await loadData(token, company.id);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to update company"
      );
    } finally {
      setSavingCompany(false);
    }
  }

  async function onAddContact(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !company) {
      return;
    }

    try {
      setAddingContact(true);
      await createContact(token, {
        companyId: company.id,
        name: contactName,
        email: contactEmail || undefined
      });
      setContactName("");
      setContactEmail("");
      await loadData(token, company.id);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to add contact"
      );
    } finally {
      setAddingContact(false);
    }
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">{error}</main>;
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Company Details">
        <p>Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title={company ? `Company: ${company.name}` : "Company Details"}>
      {requestError ? <p className="kv-error">{requestError}</p> : null}

      {company ? (
        <div className="kv-stack">
          <form
            onSubmit={onUpdateCompany}
            className="kv-form kv-card"
            style={{ maxWidth: "520px" }}
          >
            <h3 style={{ marginBottom: "0.25rem" }}>Edit Company</h3>
            <input
              value={industry}
              onChange={(event) => setIndustry(event.target.value)}
              placeholder="Industry"
            />
            <input
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
              placeholder="Website"
            />
            <button type="submit" disabled={savingCompany || user.role === "CEO"} className="kv-btn-primary">
              {savingCompany ? "Saving..." : "Save Company"}
            </button>
          </form>

          <section className="kv-card">
            <h3 className="kv-section-title">Contacts</h3>
            <form
              onSubmit={onAddContact}
              className="kv-form"
              style={{ maxWidth: "420px" }}
            >
              <input
                value={contactName}
                onChange={(event) => setContactName(event.target.value)}
                placeholder="Contact name"
                required
                disabled={user.role === "CEO"}
              />
              <input
                value={contactEmail}
                onChange={(event) => setContactEmail(event.target.value)}
                placeholder="Contact email"
                disabled={user.role === "CEO"}
              />
              <button type="submit" disabled={addingContact || user.role === "CEO"} className="kv-btn-primary">
                {addingContact ? "Adding..." : "Add Contact"}
              </button>
            </form>

            <div className="kv-table-wrap" style={{ marginTop: "0.75rem" }}>
            <table>
              <thead>
                <tr>
                  <th align="left">Name</th>
                  <th align="left">Email</th>
                  <th align="left">Title</th>
                  <th align="left">Created</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td>{contact.name}</td>
                    <td>{contact.email ?? "-"}</td>
                    <td>{contact.title ?? "-"}</td>
                    <td>{new Date(contact.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>

          <section className="kv-card">
            <h3 className="kv-section-title">Deals</h3>
            <div className="kv-table-wrap">
            <table>
              <thead>
                <tr>
                  <th align="left">Title</th>
                  <th align="left">Value</th>
                  <th align="left">Stage</th>
                  <th align="left">Created</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((deal) => (
                  <tr key={deal.id}>
                    <td>{deal.title}</td>
                    <td>
                      {deal.currency} {deal.valueAmount}
                    </td>
                    <td>{deal.stage}</td>
                    <td>{new Date(deal.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
        </div>
      ) : (
        <p className="kv-state">Company not found.</p>
      )}
    </AppShell>
  );
}
