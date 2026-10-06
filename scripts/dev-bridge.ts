// Browser-mode backend used by `npm run dev`. Mirrors src-tauri/src/main.rs so the
// UI behaves the same in a normal browser as in the desktop app.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY = 32 * 1024 * 1024;

export interface CurlResult {
  exitCode: number | null;
  stderr: string;
  meta: string;
  headers: string;
  body: string;
  bodyEncoding: "utf8" | "base64";
  bodySize: number;
  truncated: boolean;
  elapsedMs: number;
}

export function curlBin(): string {
  if (process.env.CURLMAN_CURL) return process.env.CURLMAN_CURL;
  if (process.platform === "win32" && process.env.SystemRoot) {
    const p = join(process.env.SystemRoot, "System32", "curl.exe");
    if (existsSync(p)) return p;
  }
  return "curl";
}

export function encodeBody(buf: Buffer): { body: string; bodyEncoding: "utf8" | "base64" } {
  const dec = new TextDecoder("utf-8", { fatal: true });
  const attempt = (b: Buffer) => {
    try {
      return dec.decode(b);
    } catch {
      return null;
    }
  };
  let text = attempt(buf);
  // allow a multi-byte character cut off by truncation at the very end
  for (let cut = 1; text === null && cut <= 3 && cut <= buf.length; cut++) {
    const b = buf[buf.length - cut];
    if (b >= 0x80 && b < 0xc0) continue; // continuation byte: keep looking for the lead
    const needed = b >= 0xf8 ? 0 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
    if (needed > cut) text = attempt(buf.subarray(0, buf.length - cut));
    break;
  }
  return text === null ? { body: buf.toString("base64"), bodyEncoding: "base64" } : { body: text, bodyEncoding: "utf8" };
}

const running = new Map<string, ChildProcess>();
const cancelled = new Set<string>();

export function runCurl(id: string, args: string[], bin = curlBin()): Promise<CurlResult> {
  const safe = id.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  const tag = `curlman-${process.pid}-${safe}`;
  const headerPath = join(tmpdir(), `${tag}.headers`);
  const bodyPath = join(tmpdir(), `${tag}.body`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const started = performance.now();
    const child = spawn(
      bin,
      [...args, "--silent", "--show-error", "--dump-header", headerPath, "--output", bodyPath, "--write-out", "%{json}\\n"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    running.set(id, child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => err.push(d));

    const cleanup = async () => {
      running.delete(id);
      const read = (p: string) => readFile(p).catch(() => Buffer.alloc(0));
      const [headers, body] = await Promise.all([read(headerPath), read(bodyPath)]);
      await Promise.all([rm(headerPath, { force: true }), rm(bodyPath, { force: true })]);
      return { headers, body };
    };

    child.on("error", async (e) => {
      if (settled) return;
      settled = true;
      await cleanup();
      reject(`Could not start curl (${bin}): ${e.message}. Is curl installed and on your PATH?`);
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      const elapsedMs = Math.round(performance.now() - started);
      const { headers, body } = await cleanup();
      if (cancelled.delete(id)) return reject("cancelled");
      const truncated = body.length > MAX_BODY;
      resolve({
        exitCode: code,
        stderr: Buffer.concat(err).toString("utf8"),
        meta: Buffer.concat(out).toString("utf8"),
        headers: headers.toString("utf8"),
        ...encodeBody(truncated ? body.subarray(0, MAX_BODY) : body),
        bodySize: body.length,
        truncated,
        elapsedMs,
      });
    });
  });
}

export function cancelCurl(id: string) {
  const child = running.get(id);
  if (child) {
    cancelled.add(id);
    child.kill();
  }
}

export function curlVersion(bin = curlBin()): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let s = "";
    child.stdout!.on("data", (d) => (s += d));
    child.on("error", (e) => reject(e.message));
    child.on("close", () => resolve(s.split(/\r?\n/)[0] ?? ""));
  });
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * HTTP endpoint for the browser build: POST /__curlman/<command>.
 * Only same-origin requests to a loopback host are served, and a custom header
 * is required, so other websites can't drive it (no CORS preflight is answered).
 */
export async function handleBridge(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(value));
  };
  const host = req.headers.host ?? "";
  const origin = req.headers.origin;
  if (
    req.method !== "POST" ||
    req.headers["x-curlman"] !== "1" ||
    !LOCAL_HOST.test(host) ||
    (origin !== undefined && origin !== `http://${host}`)
  ) {
    return send(403, { error: "forbidden" });
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let input: { id?: unknown; args?: unknown };
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return send(400, { error: "invalid JSON" });
  }
  const command = (req.url ?? "").replace(/^\//, "").split("?")[0];
  try {
    if (command === "run_curl") {
      const { id, args } = input;
      if (typeof id !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) {
        return send(400, { error: "run_curl needs { id: string, args: string[] }" });
      }
      return send(200, await runCurl(id, args as string[]));
    }
    if (command === "cancel_curl") {
      if (typeof input.id === "string") cancelCurl(input.id);
      return send(200, null);
    }
    if (command === "curl_version") return send(200, await curlVersion());
    return send(404, { error: `unknown command ${command}` });
  } catch (e) {
    return send(500, { error: String(e) });
  }
}

/** Vite plugin wiring the endpoint into `npm run dev`. */
export function curlBridge() {
  return {
    name: "curlman-dev-bridge",
    apply: "serve" as const,
    configureServer(server: { middlewares: { use: (path: string, fn: typeof handleBridge) => void } }) {
      server.middlewares.use("/__curlman", handleBridge);
    },
  };
}
