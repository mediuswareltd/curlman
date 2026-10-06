// Context-aware completions for the cURL editor: flags, methods, headers, header values.
import { takesValue } from "./parse.ts";

export type Kind = "cmd" | "flag" | "method" | "header" | "value";

export interface Suggestion {
  kind: Kind;
  label: string;
  detail?: string;
  insert: string;
  /** open completions again right after inserting (e.g. header name → values) */
  reopen?: boolean;
}

export interface Completion {
  /** range in the source that `insert` replaces */
  from: number;
  to: number;
  items: Suggestion[];
}

interface Context {
  /** completed tokens before the caret */
  tokens: string[];
  /** start of the current word segment (after an opening quote, if any) */
  segStart: number;
  quote: string;
  /** the current segment starts the token (optionally just inside its opening quote) */
  atTokenStart: boolean;
}

/** Shell-like scan of the text before the caret. */
export function contextAt(src: string, caret: number): Context {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote = "";
  let segStart = 0;
  let tokenStart = 0;
  let i = 0;
  while (i < caret) {
    const c = src[i];
    if (quote) {
      if (c === quote) {
        quote = "";
        i++;
        segStart = i;
      } else if (quote === '"' && c === "\\" && i + 1 < caret) {
        cur += src[i + 1];
        i += 2;
      } else {
        cur += c;
        i++;
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (has) tokens.push(cur);
      cur = "";
      has = false;
      i++;
      segStart = i;
      tokenStart = i;
    } else if (c === "\\" && i + 1 < caret) {
      if (src[i + 1] !== "\n") {
        cur += src[i + 1];
        has = true;
      }
      i += 2;
      segStart = i;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
      i++;
      segStart = i;
    } else if (c === "$" && src[i + 1] === "'") {
      quote = "'";
      has = true;
      i += 2;
      segStart = i;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  segStart = Math.min(segStart, caret);
  const lead = src.slice(tokenStart, segStart);
  const atTokenStart = lead === "" || (quote !== "" && (lead === quote || lead === "$'"));
  return { tokens, segStart, quote, atTokenStart };
}

// ---------------------------------------------------------------- data

interface Flag {
  short?: string;
  long: string;
  value?: string;
  detail: string;
}

export const FLAGS: Flag[] = [
  { short: "-X", long: "--request", value: "method", detail: "HTTP method" },
  { short: "-H", long: "--header", value: "header", detail: "Add a request header" },
  { short: "-d", long: "--data", value: "data", detail: "Send a body (implies POST)" },
  { long: "--data-raw", value: "data", detail: "Send a body, no @file handling" },
  { long: "--data-binary", value: "data", detail: "Send a body exactly as-is" },
  { long: "--data-urlencode", value: "data", detail: "URL-encode and send data" },
  { long: "--json", value: "data", detail: "Send JSON (sets Content-Type & Accept)" },
  { short: "-F", long: "--form", value: "name=content", detail: "Multipart form field" },
  { short: "-u", long: "--user", value: "user:password", detail: "Basic auth credentials" },
  { long: "--oauth2-bearer", value: "token", detail: "Bearer token auth" },
  { long: "--digest", detail: "Use HTTP Digest auth" },
  { short: "-b", long: "--cookie", value: "data", detail: "Send cookies" },
  { short: "-A", long: "--user-agent", value: "name", detail: "Set User-Agent" },
  { short: "-e", long: "--referer", value: "url", detail: "Set Referer" },
  { short: "-L", long: "--location", detail: "Follow redirects" },
  { long: "--max-redirs", value: "num", detail: "Maximum redirects to follow" },
  { short: "-I", long: "--head", detail: "Headers only (HEAD request)" },
  { short: "-G", long: "--get", detail: "Put -d data in the query string" },
  { long: "--url-query", value: "data", detail: "Add a query parameter" },
  { long: "--compressed", detail: "Ask for a compressed response" },
  { short: "-k", long: "--insecure", detail: "Skip TLS certificate checks" },
  { short: "-m", long: "--max-time", value: "seconds", detail: "Timeout for the whole request" },
  { long: "--connect-timeout", value: "seconds", detail: "Timeout for connecting" },
  { long: "--retry", value: "num", detail: "Retry on transient errors" },
  { short: "-x", long: "--proxy", value: "url", detail: "Use a proxy" },
  { long: "--resolve", value: "host:port:addr", detail: "Pin a host to an IP address" },
  { long: "--connect-to", value: "host:port:host:port", detail: "Redirect a connection" },
  { long: "--http1.1", detail: "Use HTTP/1.1" },
  { long: "--http2", detail: "Use HTTP/2" },
  { short: "-4", long: "--ipv4", detail: "Resolve to IPv4 only" },
  { short: "-6", long: "--ipv6", detail: "Resolve to IPv6 only" },
  { short: "-T", long: "--upload-file", value: "file", detail: "Upload a file (PUT)" },
  { long: "--cacert", value: "file", detail: "CA certificate bundle" },
  { short: "-E", long: "--cert", value: "cert[:password]", detail: "Client certificate" },
  { long: "--key", value: "key", detail: "Client private key" },
  { short: "-g", long: "--globoff", detail: "Don't treat [] {} in URLs as globs" },
  { long: "--path-as-is", detail: "Don't squash /../ in the path" },
  { short: "-r", long: "--range", value: "range", detail: "Request a byte range" },
  { long: "--aws-sigv4", value: "provider", detail: "AWS Signature v4 auth" },
  { long: "--unix-socket", value: "path", detail: "Connect through a Unix socket" },
];

const METHODS: [string, string][] = [
  ["GET", "Read a resource"],
  ["POST", "Create / submit"],
  ["PUT", "Replace a resource"],
  ["PATCH", "Partially update"],
  ["DELETE", "Remove a resource"],
  ["HEAD", "Headers only"],
  ["OPTIONS", "Allowed methods / CORS"],
];

const MIME = ["application/json", "application/x-www-form-urlencoded", "multipart/form-data", "text/plain", "text/html", "application/xml"];

export const HEADERS: Record<string, string[]> = {
  "Content-Type": MIME,
  Accept: ["application/json", "*/*", "text/html", "application/xml", "text/plain"],
  Authorization: ["Bearer ", "Basic "],
  "Accept-Encoding": ["gzip, deflate, br", "identity"],
  "Accept-Language": ["en-US,en;q=0.9"],
  "Cache-Control": ["no-cache", "no-store", "max-age=0"],
  Connection: ["keep-alive", "close"],
  Cookie: [],
  "User-Agent": [],
  Origin: [],
  Referer: [],
  "If-None-Match": [],
  "If-Modified-Since": [],
  Range: ["bytes=0-1023"],
  "X-API-Key": [],
  "X-Request-ID": [],
  "X-Requested-With": ["XMLHttpRequest"],
  "Idempotency-Key": [],
};

const HEADER_FLAGS = new Set(["-H", "--header", "--proxy-header"]);
const METHOD_FLAGS = new Set(["-X", "--request"]);
const QUOTED_VALUE_FLAGS = new Set(["-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--json", "-F", "--form"]);

// ---------------------------------------------------------------- matching

function rank(candidate: string, query: string): number {
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  if (c.startsWith(q)) return 3;
  if (c.includes(q)) return 2;
  return 0;
}

function flagItems(seg: string): Suggestion[] {
  // exact match on a switch: nothing to complete, so Enter keeps sending
  const exact = FLAGS.find((f) => f.short === seg || f.long === seg);
  if (exact && !exact.value) return [];
  const long = seg.startsWith("--");
  const query = seg.replace(/^-+/, "");
  return FLAGS.map((f) => {
    // short flags are case-sensitive (-x proxy vs -X request)
    const shortHit = !long && f.short === seg ? 4 : 0;
    const score = Math.max(shortHit, rank(f.long.slice(2), query));
    return { f, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (query ? a.f.long.length - b.f.long.length : 0))
    .map(({ f }) => {
      const flag = long || !f.short ? f.long : f.short;
      const quoted = f.value && QUOTED_VALUE_FLAGS.has(f.long) ? "'" : "";
      return {
        kind: "flag" as const,
        label: f.short ? `${f.short}, ${f.long}` : f.long,
        detail: f.value ? `<${f.value}>  ${f.detail}` : f.detail,
        insert: f.value ? `${flag} ${quoted}` : `${flag} `,
        reopen: f.long === "--header" || f.long === "--request",
      };
    });
}

function headerItems(src: string, caret: number, ctx: Context): Completion | null {
  const seg = src.slice(ctx.segStart, caret);
  const colon = seg.indexOf(":");
  if (colon < 0) {
    const open = ctx.quote ? "" : "'";
    const items = Object.keys(HEADERS)
      .map((name) => ({ name, score: rank(name, seg) }))
      .filter((x) => x.score > 0 && x.name.toLowerCase() !== seg.toLowerCase())
      .sort((a, b) => b.score - a.score)
      .map(({ name }) => ({
        kind: "header" as const,
        label: name,
        insert: `${open}${name}: `,
        reopen: HEADERS[name].length > 0,
      }));
    return items.length ? { from: ctx.segStart, to: caret, items } : null;
  }
  const name = Object.keys(HEADERS).find((h) => h.toLowerCase() === seg.slice(0, colon).trim().toLowerCase());
  if (!name) return null;
  let from = ctx.segStart + colon + 1;
  while (src[from] === " " && from < caret) from++;
  const typed = src.slice(from, caret);
  const close = ctx.quote && src[caret] !== ctx.quote ? ctx.quote : "";
  const items = HEADERS[name]
    .filter((v) => rank(v, typed) > 0 && v !== typed)
    .map((v) => ({ kind: "value" as const, label: v.trim() || v, detail: name, insert: v.endsWith(" ") ? v : v + close }));
  return items.length ? { from, to: caret, items } : null;
}

/** Completions at `caret`, or null when there is nothing useful to offer. */
export function complete(src: string, caret: number): Completion | null {
  const ctx = contextAt(src, caret);
  const seg = src.slice(ctx.segStart, caret);
  const prev = ctx.tokens[ctx.tokens.length - 1];
  // e.g. right after a closing quote, or mid-way through a concatenated token
  if (!ctx.atTokenStart) return null;

  if (ctx.tokens.length === 0 && !ctx.quote) {
    const s = seg.toLowerCase();
    return s && "curl".startsWith(s) && s !== "curl"
      ? { from: ctx.segStart, to: caret, items: [{ kind: "cmd", label: "curl", insert: "curl " }] }
      : null;
  }

  if (prev && takesValue(prev)) {
    if (METHOD_FLAGS.has(prev) && !ctx.quote) {
      const items = METHODS.filter(([m]) => m.startsWith(seg.toUpperCase()) && m !== seg).map(([m, d]) => ({
        kind: "method" as const,
        label: m,
        detail: d,
        insert: m + " ",
      }));
      return items.length ? { from: ctx.segStart, to: caret, items } : null;
    }
    if (HEADER_FLAGS.has(prev)) return headerItems(src, caret, ctx);
    return null;
  }

  if (!ctx.quote && seg.startsWith("-")) {
    const items = flagItems(seg);
    return items.length ? { from: ctx.segStart, to: caret, items } : null;
  }
  return null;
}
