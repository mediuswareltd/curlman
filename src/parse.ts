// Turns pasted cURL text into an argv array, the same way a shell would.
// Supports bash/zsh syntax (Chrome/Firefox "Copy as cURL (bash)") and
// Windows cmd syntax (Chrome "Copy as cURL (cmd)", ^ escapes).

export type Dialect = "bash" | "cmd";

export interface Tokens {
  tokens: string[];
  /** false when the text ends mid-quote or on a line continuation */
  complete: boolean;
  error?: string;
  dialect: Dialect;
}

export function detectDialect(src: string): Dialect {
  return /\^[ \t]*\r?\n|\^"/.test(src) ? "cmd" : "bash";
}

export function tokenize(src: string): Tokens {
  return detectDialect(src) === "cmd" ? tokenizeCmd(src) : tokenizeBash(src);
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

function tokenizeBash(src: string): Tokens {
  const tokens: string[] = [];
  const n = src.length;
  let cur = "";
  let has = false;
  let pendingContinuation = false;
  const push = () => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  const incomplete = (error: string): Tokens => ({ tokens, complete: false, error, dialect: "bash" });

  let i = 0;
  while (i < n) {
    const c = src[i];
    if (isSpace(c)) {
      push();
      i++;
      continue;
    }
    if (c === "\\") {
      // Line continuation. Be forgiving about trailing spaces after the backslash.
      let j = i + 1;
      while (src[j] === " " || src[j] === "\t" || src[j] === "\r") j++;
      if (j >= n || src[j] === "\n") {
        push();
        pendingContinuation = true;
        i = j + 1;
        continue;
      }
      cur += src[i + 1];
      has = true;
      pendingContinuation = false;
      i += 2;
      continue;
    }
    pendingContinuation = false;
    if (c === "#" && !has) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return incomplete("Unterminated ' quote");
      cur += src.slice(i + 1, end);
      has = true;
      i = end + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      const r = readAnsiC(src, i + 2);
      if (!r) return incomplete("Unterminated $' quote");
      cur += r.value;
      has = true;
      i = r.end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n) {
          const e = src[j + 1];
          if (e === "\n") {
            j += 2;
            continue;
          }
          if (e === '"' || e === "\\" || e === "$" || e === "`") {
            out += e;
            j += 2;
            continue;
          }
        }
        out += src[j];
        j++;
      }
      if (j >= n) return incomplete('Unterminated " quote');
      cur += out;
      has = true;
      i = j + 1;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  push();
  return { tokens, complete: !pendingContinuation, dialect: "bash" };
}

/** Reads a bash $'...' string starting just after the opening quote. */
function readAnsiC(src: string, start: number): { value: string; end: number } | null {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const pushText = (s: string) => bytes.push(...enc.encode(s));
  const pushCode = (cp: number) => pushText(String.fromCodePoint(cp));
  const SIMPLE: Record<string, string> = {
    n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b",
    f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
  };
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i };
    if (c !== "\\" || i + 1 >= src.length) {
      pushText(c);
      i++;
      continue;
    }
    const e = src[i + 1];
    i += 2;
    if (e in SIMPLE) {
      pushText(SIMPLE[e]);
    } else if (e === "x") {
      const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i, i + 2));
      if (m) {
        bytes.push(parseInt(m[0], 16));
        i += m[0].length;
      } else pushText("\\x");
    } else if (e === "u" || e === "U") {
      const max = e === "u" ? 4 : 8;
      const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(src.slice(i, i + max));
      if (m) {
        pushCode(parseInt(m[0], 16));
        i += m[0].length;
      } else pushText("\\" + e);
    } else if (e >= "0" && e <= "7") {
      const m = /^[0-7]{0,2}/.exec(src.slice(i, i + 2))!;
      bytes.push(parseInt(e + m[0], 8) & 0xff);
      i += m[0].length;
    } else {
      pushText("\\" + e);
    }
  }
  return null;
}

function tokenizeCmd(src: string): Tokens {
  // Pass 1: cmd.exe unescaping (^x -> x, ^<newline> -> continuation).
  let s = "";
  let quoted = false;
  let pendingContinuation = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      quoted = !quoted;
      s += c;
      pendingContinuation = false;
      continue;
    }
    if (!quoted && c === "^") {
      let j = i + 1;
      while (src[j] === " " || src[j] === "\t" || src[j] === "\r") j++;
      if (j >= src.length || src[j] === "\n") {
        s += " ";
        pendingContinuation = true;
        i = j;
        continue;
      }
      s += src[i + 1];
      i++;
      pendingContinuation = false;
      continue;
    }
    if (c === "\r" || c === "\n") {
      s += " ";
      continue;
    }
    if (c !== " " && c !== "\t") pendingContinuation = false;
    s += c;
  }

  // Pass 2: MSVC CRT argv rules (what curl.exe itself sees).
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let inQ = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      let k = 0;
      while (s[i + k] === "\\") k++;
      if (s[i + k] === '"') {
        cur += "\\".repeat(k >> 1);
        if (k & 1) {
          cur += '"';
          i += k + 1;
        } else i += k;
      } else {
        cur += "\\".repeat(k);
        i += k;
      }
      has = true;
      continue;
    }
    if (c === '"') {
      if (inQ && s[i + 1] === '"') {
        cur += '"';
        i += 2;
      } else {
        inQ = !inQ;
        i++;
      }
      has = true;
      continue;
    }
    if (!inQ && (c === " " || c === "\t")) {
      if (has) tokens.push(cur);
      cur = "";
      has = false;
      i++;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  if (has) tokens.push(cur);
  if (inQ) return { tokens, complete: false, error: 'Unterminated " quote', dialect: "cmd" };
  return { tokens, complete: !pendingContinuation, dialect: "cmd" };
}

// ---------------------------------------------------------------------------
// Option knowledge

/** Short options that consume a value. */
const SHORT_WITH_ARG = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz".split(""));

/** Long options that consume a value (the common ones; unknown ones are treated as switches). */
const LONG_WITH_ARG = new Set([
  "--abstract-unix-socket", "--alt-svc", "--aws-sigv4", "--cacert", "--capath", "--cert",
  "--cert-type", "--ciphers", "--config", "--connect-timeout", "--connect-to", "--continue-at",
  "--cookie", "--cookie-jar", "--crlfile", "--curves", "--data", "--data-ascii", "--data-binary",
  "--data-raw", "--data-urlencode", "--delegation", "--dns-interface", "--dns-ipv4-addr",
  "--dns-ipv6-addr", "--dns-servers", "--doh-url", "--dump-header", "--ech", "--egd-file",
  "--engine", "--etag-compare", "--etag-save", "--expect100-timeout", "--form", "--form-string",
  "--ftp-account", "--ftp-alternative-to-user", "--ftp-method", "--ftp-port", "--ftp-ssl-ccc-mode",
  "--happy-eyeballs-timeout-ms", "--haproxy-clientip", "--header", "--hostpubmd5",
  "--hostpubsha256", "--hsts", "--interface", "--ip-tos", "--json", "--keepalive-cnt",
  "--keepalive-time", "--key", "--key-type", "--krb", "--libcurl", "--limit-rate",
  "--local-port", "--login-options", "--mail-auth", "--mail-from", "--mail-rcpt", "--max-filesize",
  "--max-redirs", "--max-time", "--netrc-file", "--noproxy", "--oauth2-bearer", "--output",
  "--output-dir", "--parallel-max", "--pass", "--pinnedpubkey", "--preproxy", "--proto",
  "--proto-default", "--proto-redir", "--proxy", "--proxy-cacert", "--proxy-capath",
  "--proxy-cert", "--proxy-cert-type", "--proxy-ciphers", "--proxy-crlfile", "--proxy-header",
  "--proxy-key", "--proxy-key-type", "--proxy-pass", "--proxy-pinnedpubkey",
  "--proxy-service-name", "--proxy-tls13-ciphers", "--proxy-tlsauthtype", "--proxy-tlspassword",
  "--proxy-tlsuser", "--proxy-user", "--proxy1.0", "--pubkey", "--quote", "--random-file",
  "--range", "--rate", "--referer", "--request", "--request-target", "--resolve", "--retry",
  "--retry-delay", "--retry-max-time", "--sasl-authzid", "--service-name", "--socks4",
  "--socks4a", "--socks5", "--socks5-gssapi-service", "--socks5-hostname", "--speed-limit",
  "--speed-time", "--stderr", "--telnet-option", "--tftp-blksize", "--time-cond",
  "--tls-max", "--tls13-ciphers", "--tlsauthtype", "--tlspassword", "--tlsuser", "--trace",
  "--trace-ascii", "--trace-config", "--unix-socket", "--upload-file", "--url", "--url-query",
  "--user", "--user-agent", "--variable", "--write-out",
]);

/** Output-related options Curlman controls itself; stripped from the user's command. */
const STRIP_SWITCH = new Set([
  "-i", "--include", "-s", "--silent", "-S", "--show-error", "-v", "--verbose", "-#",
  "--progress-bar", "--no-progress-meter", "-O", "--remote-name", "--remote-name-all", "-J",
  "--remote-header-name", "--create-dirs", "-f", "--fail", "--fail-with-body", "--fail-early",
]);
const STRIP_WITH_ARG = new Set([
  "-o", "--output", "-w", "--write-out", "-D", "--dump-header", "--output-dir", "--stderr",
  "--trace", "--trace-ascii", "--trace-config", "--libcurl",
]);

const DATA_FLAGS = new Set([
  "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json",
  "-F", "--form", "--form-string",
]);

export type Part =
  | { kind: "cmd"; text: string }
  | { kind: "flag"; flag: string; value?: string }
  | { kind: "positional"; text: string };

/** Splits argv into flags (with their values) and positionals, expanding -sSL style bundles. */
export function walk(tokens: string[]): { parts: Part[]; error?: string } {
  const parts: Part[] = [];
  let toks = tokens;
  if (toks[0] === "$" || toks[0] === ">") toks = toks.slice(1);
  if (toks.length && /(^|[\\/])curl(\.exe)?$/i.test(toks[0])) {
    parts.push({ kind: "cmd", text: toks[0] });
    toks = toks.slice(1);
  }
  let endOfOptions = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (endOfOptions || t === "-" || !t.startsWith("-")) {
      parts.push({ kind: "positional", text: t });
      continue;
    }
    if (t === "--") {
      endOfOptions = true;
      continue;
    }
    if (t.startsWith("--")) {
      if (LONG_WITH_ARG.has(t)) {
        const value = toks[++i];
        if (value === undefined) return { parts, error: `${t} needs a value` };
        parts.push({ kind: "flag", flag: t, value });
      } else parts.push({ kind: "flag", flag: t });
      continue;
    }
    for (let j = 1; j < t.length; j++) {
      const flag = "-" + t[j];
      if (SHORT_WITH_ARG.has(t[j])) {
        let value = t.slice(j + 1);
        if (!value) {
          const next = toks[++i];
          if (next === undefined) return { parts, error: `${flag} needs a value` };
          value = next;
        }
        parts.push({ kind: "flag", flag, value });
        break;
      }
      parts.push({ kind: "flag", flag });
    }
  }
  return { parts };
}

export interface Prepared {
  /** argv to hand to curl (without the program name) */
  args: string[];
  method: string;
  url: string;
  error?: string;
}

export function prepare(tokens: string[]): Prepared {
  const { parts, error } = walk(tokens);
  const args: string[] = [];
  let method: string | undefined;
  let url: string | undefined;
  let head = false, data = false, upload = false, get = false;

  for (const p of parts) {
    if (p.kind === "cmd") continue;
    if (p.kind === "positional") {
      url ??= p.text;
      args.push(p.text);
      continue;
    }
    const { flag, value } = p;
    if (STRIP_SWITCH.has(flag) || STRIP_WITH_ARG.has(flag)) continue;
    args.push(flag);
    if (value !== undefined) args.push(value);
    if (flag === "-X" || flag === "--request") method = value!.toUpperCase();
    else if (flag === "-I" || flag === "--head") head = true;
    else if (flag === "-G" || flag === "--get") get = true;
    else if (flag === "-T" || flag === "--upload-file") upload = true;
    else if (flag === "--url") url ??= value;
    else if (DATA_FLAGS.has(flag)) data = true;
  }

  const resolved =
    method ?? (head ? "HEAD" : get ? "GET" : data ? "POST" : upload ? "PUT" : "GET");
  const result: Prepared = { args, method: resolved, url: url ?? "" };
  if (error) result.error = error;
  else if (!url) result.error = tokens.length ? "No URL found" : "";
  return result;
}

// ---------------------------------------------------------------------------
// Formatting

const SAFE = /^[\w@%+=:,./-]+$/;
export function shellQuote(s: string): string {
  if (s !== "" && SAFE.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/** Rewrites a command as bash, either one flag per line or on a single line. */
export function formatCommand(tokens: string[], multiline: boolean): string {
  const { parts } = walk(tokens);
  const pieces: string[] = [];
  // the URL reads best right after `curl`
  const firstUrl = parts.findIndex((p) => p.kind === "positional");
  const head = parts[0]?.kind === "cmd" ? 1 : 0;
  if (firstUrl > head) parts.splice(head, 0, ...parts.splice(firstUrl, 1));
  let hasCmd = false;
  for (const p of parts) {
    if (p.kind === "cmd") {
      hasCmd = true;
      pieces.push("curl");
    } else if (p.kind === "positional") {
      pieces.push(/^[a-z]+:\/\//i.test(p.text) ? `'${p.text.replace(/'/g, `'\\''`)}'` : shellQuote(p.text));
    } else if (p.value === undefined && /^-[^-]$/.test(p.flag) && /^-[^-]+$/.test(pieces[pieces.length - 1] ?? "")) {
      // keep short switches bundled: -s -S -L -> -sSL
      pieces[pieces.length - 1] += p.flag.slice(1);
    } else {
      pieces.push(p.value === undefined ? p.flag : `${p.flag} ${shellQuote(p.value)}`);
    }
  }
  if (!hasCmd) pieces.unshift("curl");
  if (!multiline) return pieces.join(" ");
  // keep `curl <url>` together on the first line when the URL comes first
  const [first, ...rest] = pieces;
  const lines = [first];
  if (rest.length && !rest[0].startsWith("-")) lines[0] += " " + rest.shift();
  for (const r of rest) lines.push("  " + r);
  return lines.join(" \\\n");
}

/** True when `flag` consumes the next argument as its value. */
export function takesValue(flag: string): boolean {
  if (flag.startsWith("--")) return LONG_WITH_ARG.has(flag);
  return flag.length === 2 && flag[0] === "-" && SHORT_WITH_ARG.has(flag[1]);
}
