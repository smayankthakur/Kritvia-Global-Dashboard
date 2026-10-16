# Hindi interface

Anyone can switch Kritvia to Hindi with the **हिन्दी / English** button:

- in the sidebar of the app;
- on the login and register pages;
- in the header of the public pages.

The choice is saved in the browser (`kv-lang` in localStorage and a cookie). Switching reloads the page.

## How it works

- The app is written in English. `apps/web/lib/i18n/hi.json` maps each English interface string to Hindi (about 2,250 entries).
- The dictionary loads only when Hindi is on, as its own chunk, so English users download nothing extra.
- `lib/i18n/translate.ts` translates exact, whole text nodes and the `placeholder`, `aria-label`, `title` and `alt` attributes. A MutationObserver also translates dialogs, toasts and rows that appear later.
- A few strings built from numbers or dates are handled with patterns, for example "3 unpaid" and "Every Monday at 9:00".
- Anything the dictionary doesn't know stays in English. Nothing is machine-translated at runtime, and no text leaves the browser.

## What is never translated

- **User and customer content.** Messages, drafts, chat bubbles, template previews, approval payloads and Markdown/rich text sit inside `translate="no"` (or `data-no-i18n`), so nobody's words are changed.
- **Legal text.** The Terms, Privacy Policy and other legal pages stay in English, and the English text is the binding version. In Hindi mode they show a short Hindi note saying so.
- **Code, inputs and editable areas.** `code`, `pre`, `kbd`, `textarea` and `contenteditable` are skipped.

## Adding strings

When you add interface text, add the same English string with its Hindi translation to `hi.json`.

- Keep the brand and product names (Kritvia, WhatsApp, Razorpay, GST, UPI) as they are.
- Use plain, everyday Hindi of the kind used in Indian apps. Common loanwords are fine, for example इनवॉइस and ड्राफ़्ट.

`tests/i18n.test.ts` checks the patterns, the skip rules, and that no entry is empty.
