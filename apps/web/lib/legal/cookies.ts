/**
 * Cookie Policy, version 2026-10-06. Lists every cookie and storage key Kritvia sets. When you add
 * one, add it here and, if it is not strictly necessary, register it in lib/consent.ts so the
 * consent banner asks first (tests/consent.test.ts checks the two lists agree).
 */
export const COOKIES_UPDATED = "6 October 2026";

export const COOKIES_MD = `## 1. What this policy covers

This policy explains the cookies and similar browser storage that Kritvia (app.sitelytc.com and the installable apps), provided by Sitelytc Digital Media Private Limited, uses. It forms part of our [Privacy Policy](/privacy).

A cookie is a small text file a website stores in your browser. Similar technologies include local storage and session storage, which keep small amounts of data on your device.

## 2. The short version

- **We only use what Kritvia needs to work**: keeping you signed in, protecting sign-in, and remembering your theme and the business you last used.
- **We use no advertising cookies, no analytics or tracking cookies, and no third-party trackers.** No other company sets cookies through Kritvia.
- Because every cookie we use is strictly necessary, the law does not require your consent for them, so we do not show a consent banner. If we ever add a cookie that is not strictly necessary, we will ask you first and you will be able to change your mind at any time.
- We honour the **Global Privacy Control** signal: if your browser sends it, we treat it as a refusal of any optional cookie we might add.

## 3. Cookies we set

| Name | What it does | Type | How long |
| --- | --- | --- | --- |
| kv_at | Keeps you signed in (a short-lived access token). Page scripts cannot read it. | Strictly necessary, first party | 60 minutes |
| kv_rt | Renews your sign-in without asking again. Page scripts cannot read it. | Strictly necessary, first party | 30 days |
| kv_oauth, kv_signin | Protect the Google sign-in and connection steps against forgery. | Strictly necessary, first party | 10 minutes |
| \\_\\_Host-kv_csrf | A random security token that proves a change really came from a Kritvia page (protection against cross-site request forgery). | Strictly necessary, first party | 1 year |
| kv_org, kv_venture | Remember the organisation and business you last opened. | Strictly necessary (functional), first party | 1 year |
| kv_theme | Remembers light or dark mode. | Strictly necessary (functional), first party | 1 year |

All our cookies are first-party, sent only to app.sitelytc.com over an encrypted connection, and marked SameSite to stop other sites using them.

## 4. Browser storage we use

| Key | What it does | How long |
| --- | --- | --- |
| kv_voice_* (local storage) | Your dictation settings on this device. | Until you clear it |
| kv_terms_intent (session storage) | Carries your acceptance of the Terms from the sign-up page to your new account. | Until the tab closes |
| kv_consent (local storage) | Your choice about optional cookies. Only written if we ever ask. | 12 months, then we ask again |
| App cache (installable app) | The app's layout and code, so it opens quickly. Never your business data. | Until the app updates |

## 5. Controlling cookies

You can block or delete cookies in your browser settings. If you block the strictly necessary cookies above, you will not be able to sign in to Kritvia. Signing out removes the sign-in cookies.

## 6. Changes and contact

We will update this policy, and the date at the top, whenever we add, change or remove a cookie. Questions: support@sitelytc.com with "Privacy" in the subject, or use our [privacy request form](/privacy-request).
`;
