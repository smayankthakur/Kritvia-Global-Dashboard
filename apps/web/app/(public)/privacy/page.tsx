import type { Metadata } from "next";
import { COMPANY, Doc, SUPPORT_EMAIL } from "@/components/public/doc-page";

export const metadata: Metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  return (
    <Doc
      title="Privacy policy"
      updated="3 October 2026"
      lead={`${COMPANY} ("we") runs Kritvia. This policy explains what we collect, why, and the rights you have under India's Digital Personal Data Protection Act, 2023.`}
    >
      <h2>Two kinds of data</h2>
      <ul>
        <li>
          <strong>Your account data:</strong> your name, email, sign-in records and settings. We are the data fiduciary for this.
        </li>
        <li>
          <strong>Your business&apos;s data:</strong> documents, emails, leads, loan files and other records you or your team put into
          Kritvia, including personal data of your customers. Your business decides why and how it is used; we process it only to
          provide Kritvia to you, on your instructions.
        </li>
      </ul>
      <h2>What we collect and why</h2>
      <ul>
        <li>Account details, to sign you in and contact you about your account.</li>
        <li>Content you add or connect (for example Gmail, Calendar, Drive), to run the agents and the search you ask for.</li>
        <li>
          Usage metadata (which features ran, AI model usage, errors), to operate, secure and bill the service. We do not store the
          text of your voice dictations, only their length and language.
        </li>
        <li>
          Billing details (legal name, GSTIN, address), to issue tax invoices. Card and UPI payments are handled by Razorpay; we never
          see card numbers.
        </li>
      </ul>
      <h2>AI processing</h2>
      <p>
        Sensitive records are processed only by an AI model on our own server. Other requests may be sent to hosted AI providers
        (currently Groq, Google Gemini, OpenRouter and Sarvam) to generate drafts and answers. We do not use your business&apos;s data to
        train any model, and we do not sell personal data.
      </p>
      <h2>Where data is stored</h2>
      <p>
        On servers in Mumbai, India (Amazon Web Services), with encrypted backups in the same region. Hosted AI providers may process
        request text outside India.
      </p>
      <h2>How long we keep it</h2>
      <ul>
        <li>Account data: while your account exists. Deleting your account anonymises it at once.</li>
        <li>
          Business data: until you delete it or close the organisation; a closed organisation&apos;s data is erased 30 days later. Your
          business can set shorter retention per type of document.
        </li>
        <li>Backups: up to 30 days. The audit log is kept as a legal record of activity; it holds metadata, not document contents.</li>
      </ul>
      <h2>Your rights</h2>
      <ul>
        <li>
          Access and download your data, and delete your account, from <strong>Your account</strong> in the app.
        </li>
        <li>Correct your details, withdraw consent, or nominate someone to act for you, by emailing us.</li>
        <li>
          If your data is in a business&apos;s workspace (for example you are a loan applicant), contact that business first; we help them
          answer you.
        </li>
      </ul>
      <h2>Contact and grievances</h2>
      <p>
        Grievance officer: Mayank Thakur, {COMPANY}, New Delhi. Email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-accent hover:underline">
          {SUPPORT_EMAIL}
        </a>
        . We acknowledge within 2 business days and resolve within 30 days. If you are not satisfied, you may complain to the Data
        Protection Board of India.
      </p>
    </Doc>
  );
}
