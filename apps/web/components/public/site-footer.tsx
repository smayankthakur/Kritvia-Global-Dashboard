import Link from "next/link";
import { CookieSettingsLink } from "@/components/legal/consent";
import { BUSINESS } from "@/lib/business";
import { OPTIONAL_TOOLS } from "@/lib/consent";

const GROUPS = [
  {
    title: "Product",
    links: [
      ["/welcome#pricing", "Pricing"],
      ["/security", "Security"],
      ["/status", "Status"],
      ["/help", "Help"],
    ],
  },
  {
    title: "Legal",
    links: [
      ["/terms", "Terms of Service"],
      ["/privacy", "Privacy Policy"],
      ["/cookies", "Cookie Policy"],
      ["/refunds", "Cancellation & refunds"],
    ],
  },
  {
    title: "Your data",
    links: [
      ["/privacy-request", "Privacy request"],
      ["/account", "Download or delete my data"],
      ["/help#contact", "Contact us"],
    ],
  },
] as const;

const linkClass = "rounded transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Public footer: who runs Kritvia (legal name, CIN, registered office, GSTIN when set), how to
 * reach us and the grievance officer, and every policy. Business details come from lib/business.ts.
 */
export function SiteFooter({ wide }: { wide?: boolean }) {
  const year = new Date().getFullYear();
  return (
    <footer className="glass mt-6 border-t" aria-labelledby="footer-heading">
      <h2 id="footer-heading" className="sr-only">
        About Kritvia and its policies
      </h2>
      <div className={`mx-auto grid ${wide ? "max-w-6xl" : "max-w-4xl"} gap-8 px-4 py-10 text-sm sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]`}>
        <div>
          <p className="font-semibold text-fg">
            {BUSINESS.product} by {BUSINESS.legalName}
          </p>
          <address className="mt-2 space-y-0.5 text-xs leading-relaxed text-subtle not-italic">
            <span className="block">CIN {BUSINESS.cin}</span>
            {BUSINESS.gstin ? <span className="block">GSTIN {BUSINESS.gstin}</span> : null}
            <span className="block">{BUSINESS.address ? `Registered office: ${BUSINESS.address}` : BUSINESS.city}</span>
            <span className="block">
              Email:{" "}
              <a href={`mailto:${BUSINESS.email}`} className={`text-muted underline ${linkClass}`}>
                {BUSINESS.email}
              </a>
            </span>
            <span className="block">Grievance officer: {BUSINESS.grievanceOfficer} (write with &ldquo;Grievance&rdquo; in the subject)</span>
          </address>
        </div>
        {GROUPS.map((g) => (
          <nav key={g.title} aria-label={g.title}>
            <h3 className="text-xs font-semibold tracking-wide text-fg uppercase">{g.title}</h3>
            <ul className="mt-3 space-y-2 text-muted">
              {g.links.map(([href, label]) => (
                <li key={href}>
                  <Link href={href} className={linkClass}>
                    {label}
                  </Link>
                </li>
              ))}
              {g.title === "Legal" && OPTIONAL_TOOLS.length ? (
                <li>
                  <CookieSettingsLink className={linkClass} />
                </li>
              ) : null}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-border">
        <p className={`mx-auto ${wide ? "max-w-6xl" : "max-w-4xl"} px-4 py-4 text-xs text-subtle`}>
          © {year} {BUSINESS.legalName}. Prices exclude 18% GST. No advertising or tracking cookies.
        </p>
      </div>
    </footer>
  );
}
