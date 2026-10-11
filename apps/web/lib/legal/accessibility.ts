/**
 * Accessibility statement. Must agree with docs/accessibility.md: what was tested, the known gaps
 * and how to report a barrier. Update the date when either changes.
 */
export const ACCESSIBILITY_UPDATED = "11 October 2026";

export const ACCESSIBILITY_MD = `We want everyone to be able to use Kritvia, including people who use a screen reader, a keyboard instead of a mouse, magnification, voice input or high-contrast settings. This statement covers the Kritvia web app and website at app.sitelytc.com, provided by Sitelytc Digital Media Private Limited.

## Our target

We aim to meet the **Web Content Accessibility Guidelines (WCAG) 2.2 at level AA**. The website and web app **partly meet** this standard: our automated checks find no failures, but a full test by people who use assistive technology hasn't been done yet, and the known gaps below remain.

## What you can do

- Use every screen with a keyboard alone. **Skip to content** is the first link on each page, and the focused item always shows a clear outline.
- Use a screen reader. Every page has headings and landmarks, buttons and images are named, form errors are read out, and links that open a new tab say so.
- Zoom in, or use a phone-sized window, without losing content or scrolling sideways.
- Use light or dark mode. Text meets at least 4.5:1 contrast in both.
- Turn off animation with your system's "reduce motion" setting.
- Move task-board cards with the keyboard: Space to pick a card up, the arrow keys to move it, Space to drop it and Esc to cancel.
- Speak instead of typing with the microphone button, in English, Hindi or Hinglish.

## Known gaps

| Where | What may be hard | What we are doing |
| --- | --- | --- |
| Desktop companion app | Not yet tested with screen readers | Testing before its public release |
| Emails Kritvia sends | Not covered by our automated checks | Checking them by hand with a screen reader |
| Google Drive file picker | This is Google's own window; its accessibility is Google's | You can also upload files directly from your computer |
| Documents and drafts | Files you upload, and text the AI writes, may not be fully accessible (for example, a scanned PDF has no readable text) | Drafts are plain text you can read and edit before anything is sent |
| Whole app | No full test yet by people who use assistive technology | A test with NVDA and VoiceOver before our public launch |

## How we test

Every change is checked automatically: contrast for every colour in both themes, accessibility rules in our code checks, and before each release an automated audit of the rendered pages in both themes, at phone and desktop width, including keyboard checks. The last full audit was on 6 October 2026 and found no failures. Automated tools find only part of real-world problems, which is why the hands-on tests above are planned.

## Tell us about a barrier

If something in Kritvia is hard or impossible for you to use, please tell us. We'll fix it if we can, and in the meantime help you get the information or complete the task another way.

- Email **support@sitelytc.com** with "Accessibility" in the subject.
- Tell us the page or screen, what you were trying to do, and the device, browser and any assistive technology you use.
- We reply within **5 business days**.

If you are not satisfied with our answer, you can use the grievance process in our [Privacy Policy](/privacy).

## About this statement

This statement was last reviewed on ${ACCESSIBILITY_UPDATED}. We review it whenever we test again or change how Kritvia works, and at least once a year.`;
