import type { Metadata } from "next";
import { COMPANY, Doc, SUPPORT_EMAIL } from "@/components/public/doc-page";

export const metadata: Metadata = { title: "Terms of service" };

export default function TermsPage() {
  return (
    <Doc title="Terms of service" updated="3 October 2026" lead={`These terms are an agreement between your business and ${COMPANY} for the use of Kritvia.`}>
      <h2>1. The service</h2>
      <p>
        Kritvia is software that stores your business records, answers questions about them, and runs AI agents that draft work for
        your approval. Features and limits depend on your plan.
      </p>
      <h2>2. Your account</h2>
      <ul>
        <li>You must be at least 18 and able to act for the business that signs up.</li>
        <li>Keep sign-in access secure. You are responsible for what people you invite do in your workspace.</li>
      </ul>
      <h2>3. Your data</h2>
      <ul>
        <li>
          Your business owns its data. We use it only to provide the service, as described in our{" "}
          <a href="/privacy" className="text-accent hover:underline">
            Privacy policy
          </a>
          .
        </li>
        <li>You confirm you have the right to put personal data of your customers into Kritvia and, where required, their consent.</li>
      </ul>
      <h2>4. AI output and approvals</h2>
      <ul>
        <li>AI drafts can be wrong. Review them before approving; once you approve an action (for example sending an email), it is your action.</li>
        <li>
          Kritvia does not give legal, tax, credit or financial advice. Loan document checks support, but do not replace, a lender&apos;s
          own verification.
        </li>
      </ul>
      <h2>5. Acceptable use</h2>
      <p>Do not use Kritvia to send spam, to break the law, to process data you are not allowed to, or to probe or overload the service.</p>
      <h2>6. Plans, payment and cancellation</h2>
      <ul>
        <li>Paid plans are billed monthly in advance through Razorpay, plus GST. Prices are shown on the Plan &amp; billing page.</li>
        <li>
          You can cancel any time; the plan runs to the end of the paid month, then moves to Free. We do not refund part-months, except
          where the law requires.
        </li>
        <li>We will give at least 30 days&apos; notice of a price increase.</li>
      </ul>
      <h2>7. Availability</h2>
      <p>
        We aim for 99.5% monthly availability and post incidents on the{" "}
        <a href="/status" className="text-accent hover:underline">
          status page
        </a>
        , but do not guarantee uninterrupted service.
      </p>
      <h2>8. Liability</h2>
      <p>
        To the extent the law allows, our total liability for any claim is limited to the fees you paid in the 12 months before it, and
        we are not liable for indirect or consequential loss.
      </p>
      <h2>9. Ending the agreement</h2>
      <p>
        You can delete your account at any time. We may suspend accounts that break these terms after notice, except where immediate
        action is needed to protect others.
      </p>
      <h2>10. Law</h2>
      <p>
        These terms are governed by the laws of India; courts in New Delhi have jurisdiction. Questions:{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-accent hover:underline">
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
    </Doc>
  );
}
