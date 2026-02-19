"use client";

import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { useAuthUser } from "../../lib/use-auth-user";

type ProfilePreferences = {
  phone: string;
  title: string;
  department: string;
  timezone: string;
  language: string;
  emailNotifications: boolean;
  productNotifications: boolean;
};

const PROFILE_PREFS_KEY = "kritviya_profile_preferences_v1";

const defaultPreferences: ProfilePreferences = {
  phone: "",
  title: "",
  department: "",
  timezone: "UTC",
  language: "English",
  emailNotifications: true,
  productNotifications: true
};

export default function ProfilePage() {
  const { user, loading, error } = useAuthUser();
  const [name, setName] = useState("");
  const [prefs, setPrefs] = useState<ProfilePreferences>(defaultPreferences);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      return;
    }
    setName(user.name);
  }, [user]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PROFILE_PREFS_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<ProfilePreferences>;
      setPrefs((current) => ({ ...current, ...parsed }));
    } catch {
      // Ignore malformed local profile cache.
    }
  }, []);

  function updatePref<Key extends keyof ProfilePreferences>(key: Key, value: ProfilePreferences[Key]): void {
    setPrefs((current) => ({ ...current, [key]: value }));
  }

  function onSave(): void {
    window.localStorage.setItem(
      PROFILE_PREFS_KEY,
      JSON.stringify({
        ...prefs,
        name
      })
    );
    setStatus("Profile preferences saved locally. Server profile update is not available yet.");
  }

  if (loading) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (!user) {
    return <main className="kv-main">Redirecting to login...</main>;
  }

  return (
    <AppShell user={user} title="Profile">
      <section className="kv-card kv-glass kv-stack">
        <p className="kv-note">Manage account details and personal preferences.</p>
        {status ? <p className="kv-note">{status}</p> : null}
        <div className="kv-grid-2">
          <div className="kv-form">
            <label htmlFor="profileName">Name</label>
            <input id="profileName" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="kv-form">
            <label htmlFor="profileEmail">Email</label>
            <input id="profileEmail" value={user.email} readOnly />
          </div>
          <div className="kv-form">
            <label htmlFor="profilePhone">Phone (optional)</label>
            <input
              id="profilePhone"
              value={prefs.phone}
              onChange={(event) => updatePref("phone", event.target.value)}
            />
          </div>
          <div className="kv-form">
            <label htmlFor="profileTitle">Title (optional)</label>
            <input
              id="profileTitle"
              value={prefs.title}
              onChange={(event) => updatePref("title", event.target.value)}
            />
          </div>
          <div className="kv-form">
            <label htmlFor="profileDepartment">Department (optional)</label>
            <input
              id="profileDepartment"
              value={prefs.department}
              onChange={(event) => updatePref("department", event.target.value)}
            />
          </div>
          <div className="kv-form">
            <label htmlFor="profileTimezone">Timezone</label>
            <select
              id="profileTimezone"
              value={prefs.timezone}
              onChange={(event) => updatePref("timezone", event.target.value)}
            >
              <option value="UTC">UTC</option>
              <option value="Asia/Kolkata">Asia/Kolkata</option>
              <option value="Europe/London">Europe/London</option>
              <option value="America/New_York">America/New_York</option>
            </select>
          </div>
          <div className="kv-form">
            <label htmlFor="profileLanguage">Language</label>
            <select
              id="profileLanguage"
              value={prefs.language}
              onChange={(event) => updatePref("language", event.target.value)}
            >
              <option value="English">English</option>
            </select>
          </div>
        </div>
        <div className="kv-row">
          <label className="kv-toggle">
            <input
              type="checkbox"
              checked={prefs.emailNotifications}
              onChange={(event) => updatePref("emailNotifications", event.target.checked)}
            />
            <span>Email notifications</span>
          </label>
          <label className="kv-toggle">
            <input
              type="checkbox"
              checked={prefs.productNotifications}
              onChange={(event) => updatePref("productNotifications", event.target.checked)}
            />
            <span>Product notifications</span>
          </label>
        </div>
        <div className="kv-row">
          <button type="button" className="kv-btn-primary" onClick={onSave}>
            Save
          </button>
        </div>
      </section>
    </AppShell>
  );
}

