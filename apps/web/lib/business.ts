/**
 * Verified business details shown in the site footer, legal pages and emails. Keep these in step
 * with the Ministry of Corporate Affairs record for the CIN and with the API settings
 * (COMPANY_* in apps/api/kritvia_api/config.py). Set the registered office and GSTIN through
 * NEXT_PUBLIC_COMPANY_ADDRESS / NEXT_PUBLIC_COMPANY_GSTIN once confirmed; until then the footer
 * shows the city only rather than a guess.
 *
 * GST: until a GSTIN is set the company is not GST-registered, so no GST is charged and nothing may
 * say prices include GST or promise GST tax invoices. Setting NEXT_PUBLIC_COMPANY_GSTIN (a build
 * arg) switches the price notes below; the Terms, refund and privacy texts need updating then too.
 */
export const BUSINESS = {
  product: "Kritvia",
  legalName: "Sitelytc Digital Media Private Limited",
  shortName: "Sitelytc Digital Media Pvt. Ltd.",
  cin: "U63121DL2025PTC453508",
  city: "New Delhi, India",
  address: process.env.NEXT_PUBLIC_COMPANY_ADDRESS?.trim() || "",
  gstin: process.env.NEXT_PUBLIC_COMPANY_GSTIN?.trim() || "",
  email: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@sitelytc.com",
  grievanceOfficer: "Mayank Thakur",
} as const;

export const GST_REGISTERED = BUSINESS.gstin !== "";

/** One sentence on how GST applies to our prices, for every place a price is shown. */
export const PRICE_TAX_NOTE = GST_REGISTERED
  ? "Prices include 18% GST."
  : "No GST is charged (we are not GST-registered yet).";

