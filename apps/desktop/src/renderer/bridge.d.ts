// window.kritvia, exposed by src/preload.ts
interface KritviaBridge {
  send(channel: string, payload?: unknown): void;
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
  on(channel: string, fn: (payload: unknown) => void): () => void;
  platform: string;
}
interface Window {
  kritvia: KritviaBridge;
}
