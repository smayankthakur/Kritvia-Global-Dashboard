# How-to videos

`apps/web/public/videos/connect-apps.{mp4,webm,jpg}` is the one-minute "How to connect your apps"
walkthrough. You can watch it from Settings → Connectors and from Help, where the steps are also written
out, because the video has no sound. Re-record it whenever the Connectors screens change.

1. Run the API tests once, so the test database is migrated.
2. Start the demo API from `apps/api`:
   ```
   python ../../scripts/video/serve_demo.py
   ```
   It uses the tests' environment and fake Telegram, Meta, Slack, MCP and AI servers.
3. Build the web app and start it on :3000, with `KRITVIA_API_URL=http://localhost:8000` and
   `KRITVIA_COOKIE_SECURE=false`.
4. A bot can belong to only one business, so if you have recorded before, remove the earlier demo bot:
   ```
   DELETE FROM connectors WHERE provider = 'telegram'
   ```
   Run it in the test database.
5. Record from `apps/web`:
   ```
   cp ../../scripts/video/connect-apps.mjs . && node connect-apps.mjs && rm connect-apps.mjs
   ```
   It prints the path of the recorded `.webm`.
6. Encode. Skip the ~2 s before the title card appears:
   ```
   ffmpeg -ss 1.8 -i rec.webm -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -r 25 -movflags +faststart -an connect-apps.mp4
   ffmpeg -ss 1.8 -i rec.webm -c:v libvpx-vp9 -b:v 0 -crf 40 -row-mt 1 -r 25 -an connect-apps.webm
   ffmpeg -ss 1.8 -i rec.webm -ss 1 -frames:v 1 -q:v 5 connect-apps.jpg
   ```
7. Update `CONNECT_STEPS` in `apps/web/components/settings/how-to-video.tsx` if the steps changed.

`/videos/` is served without sign-in (`middleware.ts`), so the Help page can show the video too.
