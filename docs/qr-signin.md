# QR sign-in between your computer and phone

People sign in on a second device by scanning a QR code. There's no password to type, and nothing
signs in without a "yes" on a device that is already signed in.

| Way | Where the QR is shown | Who scans it | Who says yes |
| --- | --- | --- | --- |
| Computer → phone | **Open on your phone**: on Your account, and in the sidebar on wide screens | The phone's camera | The computer |
| Phone → computer | **Sign in with your phone** on the login page | A phone that is already signed in | The phone |

After a phone signs in, the page offers:

- **Install Kritvia**: the browser's install prompt, or Share → Add to Home Screen on iPhone;
- **Notifications**: so drafts that need a yes reach the phone.

**Your account → Your phone and other devices** lists every device that is signed in. You can sign
out any device except the one you are using. It is signed out at its next renewal, within the hour.

## How it is kept safe

- The QR holds `https://app…/link#<token>`. The token sits after the `#`, so it never reaches a
  server log or a Referer header.
- The device being signed in gets a secret. The web app keeps it in the httpOnly cookie `kv_link`
  (path `/api/auth/link`, 5 minutes), so page JavaScript never sees it.
- A code lives 3 minutes, with 2 more after it is scanned. Only the first scan counts.
- The signed-in device is shown which device scanned the code, for example "Chrome on Android",
  before anyone says yes. Each code works once.
- Tokens and secrets are stored only as SHA-256 hashes, in the table `device_links`. That table has
  RLS with no app policies and is reached only through SECURITY DEFINER functions (migration 0048).
  Rows are deleted after a day.
- Approvals and QR sign-ins are written to the security log (`auth.device_link_*`).

## Code

| Part | Where |
| --- | --- |
| API | `routers/device_link.py`, `migrations/0048_device_links.sql`, `tests/test_device_link.py` |
| BFF | `lib/bff/link.ts`, with the routes under `app/api/auth/link/*`. These are blocked in the generic proxy. |
| Pages | `app/(auth)/link` (the phone side), `components/devices/*`, `components/auth/phone-signin.tsx` |
| Install | `lib/install.ts`, which catches `beforeinstallprompt` as soon as the app loads |
