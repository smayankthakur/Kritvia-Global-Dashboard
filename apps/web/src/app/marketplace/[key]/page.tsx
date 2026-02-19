"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  MarketplaceAppDetail,
  disableOrgApp,
  disconnectOrgAppOAuth,
  enableOrgApp,
  getMarketplaceApp,
  installOrgApp,
  rotateOrgAppSecret,
  startOrgAppOAuth,
  uninstallOrgApp,
  updateOrgAppConfig
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

function canManage(role: string): boolean {
  return role === "CEO" || role === "ADMIN";
}

export default function MarketplaceDetailPage() {
  const params = useParams<{ key: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const appKey = params?.key ?? "";
  const { user, token, loading, error, activeOrgName } = useAuthUser();
  const [app, setApp] = useState<MarketplaceAppDetail | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configText, setConfigText] = useState("{\n  \n}");
  const [secretOneTime, setSecretOneTime] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const status = app?.install?.status ?? "NOT_INSTALLED";
  const isInstalled = app?.installed && status !== "UNINSTALLED";
  const canManageApp = Boolean(user && canManage(user.role));
  const supportsOauth = Boolean(app?.oauthProvider);
  const oauthConnected = Boolean(app?.install?.oauthConnected);
  const oauthAccountId = app?.install?.oauthAccountId ?? null;
  const oauthExpiresAt = app?.install?.oauthExpiresAt ?? null;

  const scopes = useMemo(() => app?.scopes ?? [], [app]);
  const webhookEvents = useMemo(() => app?.webhookEvents ?? [], [app]);

  const loadApp = useCallback(
    async (currentToken: string): Promise<void> => {
      if (!appKey) {
        return;
      }
      try {
        setLoadingData(true);
        setRequestError(null);
        const response = await getMarketplaceApp(currentToken, appKey);
        setApp(response);
      } catch (requestFailure) {
        setRequestError(
          requestFailure instanceof Error ? requestFailure.message : "Failed to load app details"
        );
      } finally {
        setLoadingData(false);
      }
    },
    [appKey]
  );

  useEffect(() => {
    if (!token) {
      return;
    }
    void loadApp(token);
  }, [token, loadApp]);

  useEffect(() => {
    if (!token || !appKey) {
      return;
    }

    const connected = searchParams.get("connected");
    const oauthError = searchParams.get("error");

    if (connected === "true") {
      setToast("Connected successfully.");
      setRequestError(null);
      void loadApp(token);
      router.replace(`/marketplace/${appKey}`);
      return;
    }

    if (oauthError) {
      setRequestError("OAuth connection failed. Please retry.");
      router.replace(`/marketplace/${appKey}`);
    }
  }, [token, appKey, searchParams, router, loadApp]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function onInstall(): Promise<void> {
    if (!token || !appKey) {
      return;
    }
    try {
      setSaving(true);
      setRequestError(null);
      const response = await installOrgApp(token, appKey);
      setSecretOneTime(response.appSecret);
      setToast("App installed.");
      await loadApp(token);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required to install this app. Open /billing.");
        return;
      }
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Install failed");
    } finally {
      setSaving(false);
    }
  }

  async function onConnectOAuth(): Promise<void> {
    if (!token || !appKey) {
      return;
    }
    try {
      setSaving(true);
      setRequestError(null);
      const response = await startOrgAppOAuth(token, appKey);
      window.location.href = response.authUrl;
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "OAuth connection failed"
      );
      setSaving(false);
    }
  }

  async function onDisconnectOAuth(): Promise<void> {
    if (!token || !appKey) {
      return;
    }
    if (!window.confirm("Disconnect OAuth for this app?")) {
      return;
    }
    try {
      setSaving(true);
      await disconnectOrgAppOAuth(token, appKey);
      setToast("OAuth disconnected.");
      await loadApp(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to disconnect OAuth"
      );
    } finally {
      setSaving(false);
    }
  }

  async function onRotateSecret(): Promise<void> {
    if (!token || !appKey) {
      return;
    }
    if (!window.confirm("Rotate app secret now? Existing secret will stop working.")) {
      return;
    }
    try {
      setSaving(true);
      const response = await rotateOrgAppSecret(token, appKey);
      setSecretOneTime(response.appSecret);
      setToast("Secret rotated.");
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Secret rotation failed");
    } finally {
      setSaving(false);
    }
  }

  async function onDisable(): Promise<void> {
    if (!token || !appKey) {
      return;
    }
    try {
      setSaving(true);
      await disableOrgApp(token, appKey);
      setToast("App disabled.");
      await loadApp(token);
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Disable failed");
    } finally {
      setSaving(false);
    }
  }

  async function onEnable(): Promise<void> {
    if (!token || !appKey) {
      return;
    }
    try {
      setSaving(true);
      await enableOrgApp(token, appKey);
      setToast("App enabled.");
      await loadApp(token);
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Enable failed");
    } finally {
      setSaving(false);
    }
  }

  async function onUninstall(): Promise<void> {
    if (!token || !appKey) {
      return;
    }
    if (!window.confirm("Uninstall this app? Config and secret will be removed.")) {
      return;
    }
    try {
      setSaving(true);
      await uninstallOrgApp(token, appKey);
      setSecretOneTime(null);
      setToast("App uninstalled.");
      await loadApp(token);
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Uninstall failed");
    } finally {
      setSaving(false);
    }
  }

  async function onSaveConfig(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !appKey) {
      return;
    }
    try {
      const parsed = JSON.parse(configText) as Record<string, unknown>;
      setSaving(true);
      await updateOrgAppConfig(token, appKey, parsed);
      setConfigOpen(false);
      setToast("Config saved.");
      await loadApp(token);
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Config update failed");
    } finally {
      setSaving(false);
    }
  }

  async function onCopySecret(): Promise<void> {
    if (!secretOneTime) {
      return;
    }
    await navigator.clipboard.writeText(secretOneTime);
    setToast("Secret copied.");
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  return (
    <AppShell user={user} title="Marketplace App">
      <Link href="/marketplace">&larr; Back to Marketplace</Link>

      {requestError ? (
        <p className="kv-error">
          {requestError} {requestError.includes("Upgrade required") ? <Link href="/billing">Open Billing</Link> : null}
          {requestError.includes("OAuth connection failed") && canManageApp && supportsOauth ? (
            <>
              {" "}
              <button type="button" onClick={() => void onConnectOAuth()} disabled={saving}>
                Retry connect
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {toast ? <p className="kv-marketplace-toast">{toast}</p> : null}

      {secretOneTime ? (
        <div className="kv-card kv-marketplace-secret-card">
          <p className="kv-marketplace-secret-title">App secret (shown once)</p>
          <p className="kv-subtitle kv-marketplace-secret-note">
            Save this secret now. You cannot view it again.
          </p>
          <div className="kv-row">
            <input value={secretOneTime} readOnly />
            <button type="button" onClick={() => void onCopySecret()}>
              Copy
            </button>
          </div>
        </div>
      ) : null}

      {loadingData || !app ? (
        <div className="kv-stack">
          <div className="kv-revenue-skeleton" />
          <div className="kv-revenue-skeleton" />
        </div>
      ) : (
        <div className="kv-stack">
          <article className="kv-card kv-portfolio-card">
            <h2 className="kv-section-title kv-revenue-title kv-marketplace-detail-title">
              {app.name}
            </h2>
            <p className="kv-subtitle">{app.description}</p>
            <div className="kv-row kv-marketplace-detail-pills">
              <span className="kv-pill">{app.category || "General"}</span>
              <span className="kv-pill">{app.key}</span>
              {isInstalled ? <span className="kv-pill">Installed in {activeOrgName}</span> : null}
              {isInstalled ? <span className="kv-pill">Status: {status}</span> : null}
              {supportsOauth && oauthConnected ? <span className="kv-pill">Connected</span> : null}
            </div>
            {supportsOauth && oauthConnected ? (
              <div className="kv-row kv-marketplace-oauth-row">
                <span className="kv-subtitle">
                  Connected to {app.oauthProvider} account{oauthAccountId ? ` (${oauthAccountId})` : ""}
                </span>
                {oauthExpiresAt ? (
                  <span className="kv-subtitle">Token expiry: {new Date(oauthExpiresAt).toLocaleString()}</span>
                ) : null}
              </div>
            ) : null}
            {app.websiteUrl ? (
              <p className="kv-marketplace-website">
                Website:{" "}
                <a href={app.websiteUrl} target="_blank" rel="noreferrer">
                  {app.websiteUrl}
                </a>
              </p>
            ) : null}
          </article>

          <div className="kv-grid-2">
            <section className="kv-card">
              <h3 className="kv-section-title kv-marketplace-section-title">
                Scopes
              </h3>
              <div className="kv-row">
                {scopes.length === 0 ? <span className="kv-subtitle">No scopes</span> : null}
                {scopes.map((scope) => (
                  <span className="kv-pill" key={scope}>
                    {scope}
                  </span>
                ))}
              </div>
            </section>
            <section className="kv-card">
              <h3 className="kv-section-title kv-marketplace-section-title">
                Webhook Events
              </h3>
              <div className="kv-row">
                {webhookEvents.length === 0 ? <span className="kv-subtitle">No events</span> : null}
                {webhookEvents.map((eventName) => (
                  <span className="kv-pill" key={eventName}>
                    {eventName}
                  </span>
                ))}
              </div>
            </section>
          </div>

          {canManageApp ? (
            <section className="kv-card">
              <h3 className="kv-section-title kv-marketplace-section-title">
                Manage Installation
              </h3>
              <div className="kv-row">
                {!isInstalled ? (
                  supportsOauth ? (
                    <button
                      type="button"
                      className="kv-btn-primary"
                      onClick={() => void onConnectOAuth()}
                      disabled={saving}
                    >
                      Connect
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="kv-btn-primary"
                      onClick={() => void onInstall()}
                      disabled={saving}
                    >
                      Install
                    </button>
                  )
                ) : (
                  <>
                    <button type="button" onClick={() => setConfigOpen(true)} disabled={saving || status !== "INSTALLED"}>
                      Configure
                    </button>
                    <button type="button" onClick={() => void onRotateSecret()} disabled={saving}>
                      Rotate secret
                    </button>
                    {status === "DISABLED" ? (
                      <button type="button" onClick={() => void onEnable()} disabled={saving}>
                        Enable
                      </button>
                    ) : (
                      <button type="button" onClick={() => void onDisable()} disabled={saving}>
                        Disable
                      </button>
                    )}
                    {supportsOauth ? (
                      <>
                        {oauthConnected ? (
                          <button type="button" onClick={() => void onDisconnectOAuth()} disabled={saving}>
                            Disconnect
                          </button>
                        ) : null}
                        <button type="button" onClick={() => void onConnectOAuth()} disabled={saving}>
                          {oauthConnected ? "Reconnect" : "Connect"}
                        </button>
                      </>
                    ) : null}
                    <button type="button" onClick={() => void onUninstall()} disabled={saving}>
                      Uninstall
                    </button>
                  </>
                )}
              </div>
            </section>
          ) : (
            <section className="kv-card">
              <p className="kv-marketplace-empty">Only CEO and ADMIN can install or configure this app.</p>
            </section>
          )}
        </div>
      )}

      {configOpen ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h3 className="kv-marketplace-section-title">Configure app (JSON)</h3>
            <form className="kv-form" onSubmit={(event) => void onSaveConfig(event)}>
              <textarea
                className="kv-marketplace-config-textarea"
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                rows={12}
              />
              <div className="kv-row kv-marketplace-actions-end">
                <button type="button" onClick={() => setConfigOpen(false)} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="kv-btn-primary" disabled={saving}>
                  Save config
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
