# Explicit consent in forms

Consent under the DPDP Act (s.6) and GDPR must be free, specific, informed, unconditional and
unambiguous, given by a clear affirmative action, and as easy to withdraw as to give.

## Checklist for every form that collects personal data

- [ ] The purpose is stated next to the form, in plain words (what, why, how long), with a link to the
      Privacy Policy. For a business's own customers, the business's privacy notice (Settings → Privacy
      notice) is linked or shown.
- [ ] Every consent is a separate, **unticked** checkbox the person ticks themselves. No pre-ticked boxes
      (the trust scan fails on `defaultChecked`), no consent buried in "By continuing you agree…" text
      for anything beyond the contract itself.
- [ ] Consents for different purposes are separate (e.g. accepting the Terms vs. product emails vs.
      dictation). Using the service is never made conditional on an unrelated consent.
- [ ] The submit button says what happens ("Send request", "Create account"), not "Continue".
- [ ] Withdrawal is offered where the consent is given or in the same place in settings, and works in the
      same number of steps.
- [ ] What was agreed, which version and when is recorded on the server (terms version, 18+ confirmation,
      loan-applicant consents in Compliance → Consents).
- [ ] Only fields in [data-inventory.md](data-inventory.md) are asked for; optional fields are labelled.
- [ ] Error messages never reveal whether an email address has an account.

## Current forms

| Form | Consent asked | Unticked by default | Withdraw |
| --- | --- | --- | --- |
| Sign up | Terms + Privacy; 18+ confirmation (separate boxes) | Yes | Delete account in Your account |
| Terms update dialog | Same two boxes | Yes | Delete account |
| Loan applicant consent (Truhome) | Purpose-specific consent with notice version | Yes | Compliance → Consents → Withdraw |
| Push notifications | Browser permission prompt after the person switches notifications on | n/a | Switch off in settings |
| Voice dictation | Starting each dictation | n/a | Stop; "Learn from my corrections" is a separate switch, off by default (changed 5 Oct 2026; it was on) |
| Optional cookies (when any exist) | Banner: Reject all / Accept all / Choose, equal weight | Yes | Footer → Cookie settings |
| Product emails (when any are sent) | Unsubscribe link and one-click header in each email | n/a | One click, undo available |
