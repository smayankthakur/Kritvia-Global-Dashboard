# Kritvia Voice (desktop companion)

Hold a key in **any app**, speak, release — your words are typed where the cursor is, spelled
the way your business spells them. It is a thin client: transcription, your vocabulary,
filters, engine (Sarvam / Whisper / local) and insights all live in Kritvia.

| | |
|---|---|
| Push-to-talk | Hold the key set in Kritvia → Voice → Settings (default **Right Ctrl**). Pressing another key while holding cancels, so shortcuts keep working. **Esc** cancels. |
| Floating widget | Draggable, click-through when idle, stays on top of full-screen apps, never steals focus. Click it to start/stop. Hide it from its toolbar or the tray. |
| Modes | **Type** — pasted at the cursor (your clipboard is restored afterwards). **Note** — saved to the venture's Knowledge as a voice note. |
| Auto-learn | Fix a dictated word right after it's typed and the widget asks “Remember this?” — save it for yourself or the team. |
| Account | Signs in to your Kritvia API with your normal login. The refresh token is encrypted by the OS (DPAPI / Keychain / libsecret) and never reaches the UI. |

## Install

Download from the repository's **Releases** (tag `desktop-v*`), or run the *desktop* workflow
manually and take the artifacts.

* **Windows:** run `Kritvia-Voice-Setup-<version>-x64.exe`. Builds are unsigned unless you add
  code-signing secrets, so SmartScreen shows “More info → Run anyway”.
* **macOS:** open the `.dmg`, drag to Applications, then allow it in System Settings →
  Privacy & Security → **Microphone** and **Accessibility** (needed for the hotkey and for
  pasting). Unsigned builds need right-click → Open the first time.
* **Linux:** `chmod +x Kritvia-Voice-*.AppImage`. The global hotkey needs an X11 session
  (Wayland blocks global key hooks); the widget works either way.

Sign in with your **API address** (e.g. `https://api.yourcompany.com`, HTTPS required except
`localhost`), email and password.

## Develop

```bash
cd apps/desktop
npm ci
npm test          # unit tests (keys, keystroke reconstruction, paste, API client, storage)
npm start         # build and run
npm run dist      # installers for the current OS into release/
```

The hotkey state machine and the auto-learn diff are shared with the web app
(`apps/web/lib/voice/*`). Portions are ported from AIT-Scribe (MIT) — see
`THIRD_PARTY_NOTICES.md` at the repository root.

## Limits

* The keystroke watcher that powers auto-learn follows US-layout typing; with other layouts or
  an IME it simply doesn't offer a correction (fix words in Kritvia → Voice → Vocabulary).
* The first ~200 ms after pressing the key can be lost while the microphone opens; start
  speaking a beat after pressing.
