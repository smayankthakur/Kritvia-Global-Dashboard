import type { Metadata } from "next";
import { INDEX } from "@/lib/site";
import { Doc, SUPPORT_EMAIL } from "@/components/public/doc-page";

export const metadata: Metadata = {
  title: "Security",
  description: "How Kritvia keeps business data safe: approvals before anything is sent, per-business encryption, data in India.",
  robots: INDEX,
  alternates: { canonical: "/security" },
};

export default function SecurityPage() {
  return (
    <Doc
      title="How Kritvia keeps your business safe"
      lead="Kritvia's agents draft; you decide. Nothing is sent, paid or changed outside Kritvia without your approval, and every business you run is sealed off from every other one."
    >
      <h2>Nothing goes out without you</h2>
      <ul>
        <li>Emails, calendar invites and other outgoing actions wait in your Inbox for approval. You can edit before approving.</li>
        <li>
          An agent can earn the right to act alone on one specific action only after a long run of approvals without edits, and only on
          paid plans. You can take that right back at any time.
        </li>
        <li>Prices in proposals come from your rate card, computed by code, never invented by an AI model.</li>
      </ul>
      <h2>Each business is sealed off</h2>
      <ul>
        <li>
          Every record carries its business and organisation, and the database itself (PostgreSQL row-level security) refuses to show it
          to anyone without access. A bug in our application code cannot leak one business&apos;s data to another.
        </li>
        <li>Sensitive records (for example loan applicants&apos; documents) are visible only to the roles that need them.</li>
      </ul>
      <h2>Encryption</h2>
      <ul>
        <li>All traffic is encrypted in transit (TLS through Cloudflare). The server has no open inbound ports.</li>
        <li>Documents, email bodies and connector tokens are encrypted at rest with a separate key per business (envelope encryption).</li>
        <li>Nightly backups are encrypted before they leave the server; the decryption key is held offline.</li>
        <li>Your data is stored in India (Amazon Web Services, Mumbai). Kritvia uses no advertising or analytics trackers.</li>
      </ul>
      <h2>Where AI models run</h2>
      <ul>
        <li>
          Sensitive data (identity documents, bank statements, anything marked sensitive) is processed only by a model running on
          Kritvia&apos;s own server. This rule is enforced in code for every request.
        </li>
        <li>
          Emails and WhatsApp messages that contain an Aadhaar, PAN, passport, bank-account or card number are treated the same way.
          Aadhaar and card numbers are also masked, keeping only the last four digits, when documents are stored.
        </li>
        <li>
          Other requests may use hosted models (Groq, Google Gemini) on terms under which the provider does not train on your data.
          Search indexes and text recognition always run on our own server.
        </li>
        <li>Calculation jobs such as forecasts run in an isolated sandbox (gVisor) with no network access.</li>
      </ul>
      <h2>A record of everything</h2>
      <ul>
        <li>
          Every change, approval and agent action is written to a tamper-evident audit log (each entry is hash-chained to the previous
          one). Owners can verify the chain from the Audit log page.
        </li>
      </ul>
      <h2>Your rights</h2>
      <ul>
        <li>
          Download your data or delete your account from <strong>Your account</strong> at any time. See the{" "}
          <a href="/privacy" className="text-accent underline underline-offset-2">
            Privacy policy
          </a>
          .
        </li>
      </ul>
      <h2>Report a problem</h2>
      <p>
        Found a security issue? Email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-accent underline underline-offset-2">
          {SUPPORT_EMAIL}
        </a>{" "}
        with &quot;Security&quot; in the subject. We reply within two business days and do not take action against good-faith research.
      </p>
    </Doc>
  );
}
