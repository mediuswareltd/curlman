import { invoke } from "@tauri-apps/api/core";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const NO_BACKEND =
  "Curlman's backend isn't available here. Open the Curlman desktop app, or run `npm run dev` to use it in a browser.";

/**
 * Calls a backend command: Tauri IPC inside the desktop app, or the dev
 * server's /__curlman endpoint when running in a browser.
 */
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (inTauri) return invoke<T>(command, args);
  let res: Response;
  try {
    res = await fetch(`/__curlman/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-curlman": "1" },
      body: JSON.stringify(args),
    });
  } catch {
    throw NO_BACKEND;
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw NO_BACKEND;
  const data = await res.json();
  if (!res.ok) throw data?.error ?? `HTTP ${res.status}`;
  return data as T;
}
