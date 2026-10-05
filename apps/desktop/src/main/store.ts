// Local state: preferences as JSON, the refresh token encrypted with the OS keychain
// (DPAPI on Windows, Keychain on macOS, libsecret on Linux). If the OS offers no encryption
// the token is kept in memory only and you sign in again after a restart.

import fs from "node:fs";
import path from "node:path";
import type { TokenStore } from "./api";

export interface Prefs {
  server: string;            // Kritvia API, e.g. https://api.example.com
  webUrl: string;            // Kritvia web app, for "Open Kritvia"
  ventureId: string | null;
  mode: "type" | "note";
  bubble: { x: number; y: number } | null;
  launchAtLogin: boolean;
  showBubble: boolean;
  autoLearn: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  server: "",
  webUrl: "",
  ventureId: null,
  mode: "type",
  bubble: null,
  launchAtLogin: false,
  showBubble: true,
  autoLearn: false, // keystroke-based learning stays off until the person turns it on (Privacy Policy 2)
};

export interface Crypto {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

export class PrefsStore {
  private file: string;
  data: Prefs;

  constructor(dir: string) {
    this.file = path.join(dir, "prefs.json");
    this.data = { ...DEFAULT_PREFS };
    try {
      this.data = { ...DEFAULT_PREFS, ...(JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Prefs>) };
    } catch {
      /* first run */
    }
  }

  update(patch: Partial<Prefs>): Prefs {
    this.data = { ...this.data, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    return this.data;
  }
}

export class SecureTokenStore implements TokenStore {
  private file: string;
  private memory: string | null = null;

  constructor(dir: string, private crypto: Crypto) {
    this.file = path.join(dir, "session.bin");
  }

  load(): string | null {
    if (this.memory) return this.memory;
    if (!this.crypto.isEncryptionAvailable()) return null;
    try {
      this.memory = this.crypto.decryptString(fs.readFileSync(this.file));
      return this.memory;
    } catch {
      return null;
    }
  }

  save(token: string | null): void {
    this.memory = token;
    try {
      if (!token) {
        fs.rmSync(this.file, { force: true });
        return;
      }
      if (!this.crypto.isEncryptionAvailable()) return; // memory only
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, this.crypto.encryptString(token), { mode: 0o600 });
    } catch {
      /* keep the in-memory session */
    }
  }
}
