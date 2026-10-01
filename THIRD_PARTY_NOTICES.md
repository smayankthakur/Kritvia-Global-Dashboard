# Third-party notices

## AIT-Scribe

Source: https://github.com/aithinkers/scribe

Kritvia's voice features port logic from AIT-Scribe: the transcript cleanup filters (caption
annotations, stuck loops, filler words, profanity), the vocabulary replacement, the auto-learn
single-region diff, the keystroke-reconstruction watcher, push-to-talk chord cancelling, tail
capture, the stale-session guard and clipboard restore. Files:

* `apps/api/kritvia_api/services/speech.py`
* `apps/web/lib/voice/learn.ts`, `apps/web/lib/voice/hotkey.ts`, `apps/web/lib/voice/recorder.ts`
* `apps/desktop/src/main/keystroke-watch.ts`, `apps/desktop/src/main/paste.ts`

```
MIT License

Copyright (c) 2024-2026 AI Thinkers LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
