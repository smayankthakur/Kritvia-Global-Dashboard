// The only bridge between the sandboxed pages and the main process: a fixed list of channels.
// Pages never receive tokens, only the data they display.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const SEND = new Set(["bubble:interactive", "bubble:drag-start", "bubble:drag", "bubble:drag-end", "bubble:click",
  "bubble:mode", "bubble:hide", "learn:save", "learn:dismiss", "rec:result"]);
const INVOKE = new Set(["settings:get", "settings:login", "settings:logout", "settings:update", "settings:open-web",
  "settings:refresh"]);
const LISTEN = new Set(["bubble:state", "rec:start", "rec:stop", "rec:cancel", "settings:changed"]);

contextBridge.exposeInMainWorld("kritvia", {
  send(channel: string, payload?: unknown) {
    if (SEND.has(channel)) ipcRenderer.send(channel, payload);
  },
  invoke(channel: string, payload?: unknown) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error("blocked channel"));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel: string, fn: (payload: unknown) => void) {
    if (!LISTEN.has(channel)) return () => undefined;
    const h = (_e: IpcRendererEvent, payload: unknown) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  platform: process.platform,
});
