# Kritvia — accessibility (Phase 4)

Target: **WCAG 2.2 level AA** for the web app and public site. Last audited: 6 October 2026 —
no violations on the public pages and the main app screens, light and dark, desktop and phone.

## How it is kept that way

| Check | Runs | What it catches |
| --- | --- | --- |
| `tests/contrast.test.ts` (Vitest, part of `npm test`) | every test run / CI | Every colour token in light and dark: body, muted and subtle text and links ≥ 4.5:1 on the page and on glass surfaces; button text on both ends of the accent gradient; status badges; focus ring ≥ 3:1; task-label chips |
| `eslint-plugin-jsx-a11y` rules as **errors** (`eslint.config.mjs`, part of `npm run lint`) | every lint / CI | Images without alt text, clickable `div`s without a keyboard equivalent, positive `tabIndex`, `autoFocus` misuse outside forms, invalid ARIA, labels without controls, links without content, mouse-only handlers |
| `npm run a11y` (`scripts/a11y-audit.mjs`, axe-core + Playwright) | before a release | Rendered pages against axe's WCAG 2.0/2.1/2.2 A + AA rules in both themes and two widths, plus keyboard checks: the first Tab reaches "Skip to content", every focus stop is visible with a focus indicator, and focus never gets stuck |

Run the audit against a local build:

```bash
cd apps/web && npx next build && npx next start -p 3000 &
BASE=http://localhost:3000 npm run a11y                          # public pages
BASE=http://localhost:3000 SESSION=seed.json npm run a11y        # + app screens (test account)
```

## What is in place

**Alt text.** Every `<img>`/`<Image>` has an `alt`; decorative ones use `alt=""`. Icons are SVGs
with `aria-hidden`, and icon-only buttons carry an `aria-label`. Lint fails on a missing alt.

**Colour contrast.** The light theme's accent is `#1d4ed8` (the earlier `#2563eb` was 4.43:1 on the
page tint). Links inside paragraphs are underlined, so they don't rely on colour alone. Task label
colours each pass 4.5:1 with their text colour.

**Keyboard.**
- "Skip to content" is the first stop on every page (`app/layout.tsx`) and jumps to `#main`.
- A global `:focus-visible` outline (2 px, `--ring`) shows on everything focusable; it is never
  removed without a replacement.
- No positive `tabIndex`; tab order follows reading order.
- Dialogs and sheets trap focus while open, close on Esc and return focus to what opened them.
- The task board works without a mouse: cards are dnd-kit sortables with keyboard sensors
  (Space to pick up, arrows to move, Space to drop, Esc to cancel) and screen-reader announcements.
- Wide tables in AI answers and help pages scroll inside a focusable region, so keyboard users
  can scroll them too.
- Links that open a new tab say so to screen readers ("opens in a new tab").

**Forms.** Every input has a visible label tied to it; errors are announced (`role="alert"`) and
next to the field; sign-in puts the cursor in the email field.

**Motion.** Animations respect `prefers-reduced-motion`.

## Known gaps / not yet covered

- The desktop (Electron) app and email templates are not in the automated audit; check them by
  hand with a screen reader before a major release.
- Automated tools find roughly a third of real-world problems. Before launch, do one manual pass
  with NVDA (Windows) or VoiceOver (macOS) through sign-up, creating a business, approving a draft
  and the task board.
- An accessibility statement page (who to contact about a barrier) is a good addition once the
  support address is final.
