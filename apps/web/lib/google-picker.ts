/** Google's file picker with the drive.file permission: the person chooses files, and only those
 * files become readable by Kritvia (no access to the rest of their Drive). The browser gets a
 * short-lived token for drive.file only, from Google directly; Kritvia's server then reads the
 * picked files with the business's own Google connection. */

type PickerConfig = { client_id: string; api_key: string; app_id: string; account_email?: string | null };

declare global {
  interface Window {
    gapi?: { load: (name: string, cb: () => void) => void };
    google?: {
      accounts?: { oauth2: { initTokenClient: (cfg: Record<string, unknown>) => { requestAccessToken: (o?: Record<string, unknown>) => void } } };
      picker?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
  }
}

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("Couldn't load Google's file picker"));
    document.head.appendChild(el);
  });
}

async function token(cfg: PickerConfig): Promise<string> {
  await loadScript("https://accounts.google.com/gsi/client");
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts!.oauth2.initTokenClient({
      client_id: cfg.client_id,
      scope: DRIVE_FILE,
      login_hint: cfg.account_email ?? undefined,
      callback: (r: { access_token?: string; error?: string }) => (r.access_token ? resolve(r.access_token) : reject(new Error(r.error ?? "Google sign-in was cancelled"))),
      error_callback: () => reject(new Error("Google sign-in was cancelled")),
    });
    client.requestAccessToken({ prompt: "" });
  });
}

/** Opens the picker; resolves with the chosen file IDs ([] when the person cancels). */
export async function pickDriveFiles(cfg: PickerConfig): Promise<string[]> {
  await loadScript("https://apis.google.com/js/api.js");
  await new Promise<void>((resolve) => window.gapi!.load("picker", () => resolve()));
  const accessToken = await token(cfg);
  const p = window.google!.picker!;
  return new Promise((resolve) => {
    const docs = new p.DocsView(p.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
    const picker = new p.PickerBuilder()
      .addView(docs)
      .enableFeature(p.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(accessToken)
      .setDeveloperKey(cfg.api_key)
      .setAppId(cfg.app_id)
      .setMaxItems(50)
      .setTitle("Choose files for business memory")
      .setCallback((data: { action: string; docs?: { id: string }[] }) => {
        if (data.action === p.Action.PICKED) resolve((data.docs ?? []).map((d) => d.id));
        else if (data.action === p.Action.CANCEL) resolve([]);
      })
      .build();
    picker.setVisible(true);
  });
}
