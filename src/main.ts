import { call, NO_BACKEND } from "./bridge.ts";
import { tokenize, prepare, formatCommand, shellQuote, detectDialect, type Prepared } from "./parse.ts";
import { complete, type Suggestion } from "./suggest.ts";
import { esc, highlightCurl, prettyJson, highlightJson, highlightMarkup } from "./highlight.ts";

// ---------------------------------------------------------------- types

interface CurlResult {
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

/** Subset of curl's `--write-out '%{json}'` output we use. */
interface Meta {
  response_code?: number;
  http_version?: string;
  url_effective?: string;
  num_redirects?: number;
  remote_ip?: string;
  remote_port?: number;
  content_type?: string | null;
  time_namelookup?: number;
  time_connect?: number;
  time_appconnect?: number;
  time_pretransfer?: number;
  time_starttransfer?: number;
  time_redirect?: number;
  time_total?: number;
}

type BodyKind = "empty" | "json" | "html" | "xml" | "text" | "image" | "binary";

interface View {
  req: Prepared;
  res: CurlResult;
  meta: Meta;
  status: number;
  reason: string;
  httpVersion: string;
  headers: [string, string][];
  contentType: string;
  kind: BodyKind;
  pretty: string | null;
  ms: number;
}

interface HistoryEntry {
  id: string;
  cmd: string;
  method: string;
  url: string;
  status: number;
  ms: number;
  ts: number;
}

type Tab = "body" | "headers" | "timing";

// ---------------------------------------------------------------- dom

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const main = $("main");
const editor = $<HTMLTextAreaElement>("editor");
const hl = $("hl");
const bar = $("bar");
const methodEl = $("method");
const targetEl = $("target");
const runBtn = $<HTMLButtonElement>("run");
const responseEl = $("response");
const historyEl = $("history");
const searchEl = $<HTMLInputElement>("hist-search");
const toastEl = $("toast");

const isMac = /mac/i.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

// ---------------------------------------------------------------- storage

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable; not fatal */
  }
}

const K_HISTORY = "curlman.history";
const K_DRAFT = "curlman.draft";
const K_LAYOUT = "curlman.layout";
const HISTORY_LIMIT = 300;

let history = load<HistoryEntry[]>(K_HISTORY, []);
const layout = load(K_LAYOUT, { split: 0.38, side: true });

// ---------------------------------------------------------------- helpers

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

function fmtMs(ms: number) {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function splitUrl(raw: string) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "http://" + raw);
    return { origin: u.origin === "null" ? "" : u.origin, host: u.host, path: u.pathname, query: u.search };
  } catch {
    return { origin: "", host: "", path: raw, query: "" };
  }
}

const statusClass = (s: number) => (s >= 200 && s < 600 ? `s${Math.floor(s / 100)}` : "s0");

const REASONS: Record<number, string> = {
  100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted",
  203: "Non-Authoritative Information", 204: "No Content", 206: "Partial Content",
  301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
  307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized",
  402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 408: "Request Timeout", 409: "Conflict", 410: "Gone",
  411: "Length Required", 412: "Precondition Failed", 413: "Content Too Large",
  414: "URI Too Long", 415: "Unsupported Media Type", 418: "I'm a teapot",
  422: "Unprocessable Content", 425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required",
  429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported",
};

const CURL_ERRORS: Record<number, [string, string?]> = {
  1: ["Unsupported protocol", "Check the URL scheme."],
  2: ["curl couldn't start", "Check the command's options."],
  3: ["Malformed URL", "Check the URL. Use --globoff if it contains [ ] or { }."],
  5: ["Couldn't resolve proxy"],
  6: ["Couldn't resolve host", "Check the hostname and your network or DNS."],
  7: ["Couldn't connect", "Is the server running, and is the port right?"],
  18: ["Transfer ended early"],
  23: ["Couldn't write the response"],
  26: ["Couldn't read the upload file"],
  28: ["Request timed out", "Adjust with --max-time or --connect-timeout."],
  35: ["TLS handshake failed", "The server's TLS setup may be incompatible."],
  47: ["Too many redirects", "Raise the limit with --max-redirs."],
  52: ["Empty reply from server"],
  55: ["Failed sending data"],
  56: ["Failed receiving data", "The connection was reset."],
  58: ["Problem with the client certificate"],
  60: ["Certificate verification failed", "Add -k / --insecure to skip verification for local or dev servers."],
  77: ["Problem reading the CA bundle"],
  92: ["HTTP/2 stream error"],
};

let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1600);
}

async function copy(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast("Couldn't access the clipboard");
  }
}

/** Replaces editor text while keeping native undo working. */
function setEditor(text: string) {
  editor.focus();
  editor.select();
  if (!document.execCommand("insertText", false, text)) {
    editor.value = text;
  }
  editor.setSelectionRange(0, 0);
  editor.scrollTop = 0;
  refresh();
}

// ---------------------------------------------------------------- editor + bar

let refreshQueued = false;
let draftTimer = 0;

function refresh() {
  refreshQueued = false;
  const v = editor.value;
  hl.innerHTML = splitLines(highlightCurl(v))
    .map((line, i) => `<div class="ln" data-n="${i + 1}">${line}</div>`)
    .join("");
  hl.scrollTop = editor.scrollTop;
  $("ed-dialect").textContent = detectDialect(v);
  activeLine = -1;
  updateCaret();
  renderTarget();
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => save(K_DRAFT, editor.value), 250);
}

function queueRefresh() {
  if (!refreshQueued) {
    refreshQueued = true;
    requestAnimationFrame(refresh);
  }
}

function renderTarget() {
  const v = editor.value.trim();
  targetEl.className = "";
  if (!v) {
    methodEl.style.display = "none";
    targetEl.className = "hint";
    targetEl.textContent = "Paste a cURL command above";
    return;
  }
  const tk = tokenize(v);
  const p = prepare(tk.tokens);
  methodEl.style.display = "";
  methodEl.textContent = p.method;
  methodEl.className = `method m-${p.method}`;
  const problem = (!tk.complete && tk.error) || p.error;
  if (problem) {
    targetEl.className = p.url ? "" : "error";
    if (!p.url) {
      targetEl.textContent = problem;
      return;
    }
  }
  const u = splitUrl(p.url);
  targetEl.innerHTML =
    `<span class="origin">${esc(u.origin)}</span>${esc(u.path)}` +
    (u.query ? `<span class="query">${esc(u.query)}</span>` : "");
  targetEl.title = p.url;
}

/** Splits highlighted HTML into per-line chunks, closing/reopening spans that cross a newline. */
function splitLines(html: string): string[] {
  const lines: string[] = [];
  let cur = "";
  let open: string | null = null;
  for (const [t] of html.matchAll(/<span class="[^"]*">|<\/span>|\n|[^<\n]+/g)) {
    if (t === "\n") {
      lines.push(open ? cur + "</span>" : cur);
      cur = open ?? "";
    } else {
      if (t === "</span>") open = null;
      else if (t.startsWith("<span")) open = t;
      cur += t;
    }
  }
  lines.push(cur);
  return lines;
}

let activeLine = -1;

/** Updates the active-line highlight and the Ln/Col readout. */
function updateCaret() {
  const pos = editor.selectionStart;
  const before = editor.value.slice(0, pos);
  const line = before.split("\n").length - 1;
  const col = pos - before.lastIndexOf("\n");
  $("ed-pos").textContent =
    editor.selectionEnd !== pos ? `${editor.selectionEnd - pos} selected` : `Ln ${line + 1}, Col ${col}`;
  if (line === activeLine) return;
  hl.children[activeLine]?.classList.remove("active");
  hl.children[line]?.classList.add("active");
  activeLine = line;
}

editor.addEventListener("input", (e) => {
  queueRefresh();
  if (accepting) return;
  const ie = e as InputEvent;
  if (ie.inputType === "insertText" && ie.data && !/\s$/.test(ie.data)) openSuggest();
  else if (sug && ie.inputType.startsWith("delete")) openSuggest();
  else closeSuggest();
});
editor.addEventListener("scroll", () => {
  hl.scrollTop = editor.scrollTop;
  closeSuggest();
});
for (const ev of ["keyup", "click", "focus", "select"]) editor.addEventListener(ev, updateCaret);
document.addEventListener("selectionchange", () => document.activeElement === editor && updateCaret());
editor.addEventListener("blur", () => closeSuggest());
editor.addEventListener("mousedown", () => closeSuggest());

// ---------------------------------------------------------------- autocomplete

const sugEl = $("suggest");
let sug: { from: number; to: number; items: Suggestion[]; index: number } | null = null;
let accepting = false;
const KIND_LETTER: Record<Suggestion["kind"], string> = { cmd: "$", flag: "-", method: "M", header: "H", value: "v" };

function openSuggest() {
  const caret = editor.selectionStart;
  const c = editor.selectionEnd === caret ? complete(editor.value, caret) : null;
  if (!c) return closeSuggest();
  sug = { ...c, index: 0 };
  renderSuggest();
}

function closeSuggest() {
  if (!sug) return;
  sug = null;
  sugEl.hidden = true;
  editor.removeAttribute("aria-activedescendant");
}

function renderSuggest() {
  if (!sug) return;
  const typed = editor.value.slice(sug.from, sug.to).replace(/^['"]?-*/, "").toLowerCase();
  const mark = (label: string) => {
    const i = typed ? label.toLowerCase().indexOf(typed) : -1;
    return i < 0
      ? esc(label)
      : esc(label.slice(0, i)) + `<b>${esc(label.slice(i, i + typed.length))}</b>` + esc(label.slice(i + typed.length));
  };
  const cur = sug.index;
  sugEl.innerHTML = sug.items
    .map(
      (it, i) => `
      <li id="sug-${i}" role="option" data-i="${i}" class="${i === cur ? "on" : ""}" aria-selected="${i === cur}">
        <span class="s-kind k-${it.kind}">${KIND_LETTER[it.kind]}</span>
        <span class="s-label">${mark(it.label)}</span>
        ${it.detail ? `<span class="s-detail">${esc(it.detail)}</span>` : ""}
      </li>`,
    )
    .join("");
  sugEl.hidden = false;
  editor.setAttribute("aria-activedescendant", `sug-${cur}`);
  positionSuggest();
  sugEl.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

function moveSuggest(delta: number) {
  if (!sug) return;
  const index = (sug.index + delta + sug.items.length) % sug.items.length;
  sug.index = index;
  sugEl.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("on", i === index);
    li.setAttribute("aria-selected", String(i === index));
  });
  editor.setAttribute("aria-activedescendant", `sug-${index}`);
  sugEl.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

function acceptSuggest(i = sug?.index ?? 0) {
  if (!sug) return;
  const item = sug.items[i];
  editor.setSelectionRange(sug.from, sug.to);
  accepting = true;
  document.execCommand("insertText", false, item.insert);
  accepting = false;
  closeSuggest();
  if (item.reopen) openSuggest();
}

/** Caret position in viewport coordinates, measured with an offscreen mirror. */
function caretRect() {
  const cs = getComputedStyle(editor);
  const mirror = document.createElement("div");
  const copy = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "boxSizing", "whiteSpace", "overflowWrap", "wordBreak", "tabSize", "letterSpacing", "lineHeight", "fontVariantLigatures"];
  for (const prop of copy) {
    (mirror.style as unknown as Record<string, string>)[prop] = (cs as unknown as Record<string, string>)[prop];
  }
  Object.assign(mirror.style, { position: "fixed", visibility: "hidden", top: "0", left: "0", width: `${editor.clientWidth}px` });
  mirror.textContent = editor.value.slice(0, editor.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.append(marker);
  document.body.append(mirror);
  const r = editor.getBoundingClientRect();
  const x = r.left + marker.offsetLeft;
  const y = r.top + marker.offsetTop - editor.scrollTop;
  const h = parseFloat(cs.lineHeight) || 22;
  mirror.remove();
  return { x, y, h };
}

function positionSuggest() {
  const { x, y, h } = caretRect();
  const w = sugEl.offsetWidth;
  const ph = sugEl.offsetHeight;
  const left = Math.max(8, Math.min(x - 8, window.innerWidth - w - 8));
  const below = y + h + 4;
  const top = below + ph > window.innerHeight - 8 && y - ph - 4 > 8 ? y - ph - 4 : below;
  sugEl.style.left = `${left}px`;
  sugEl.style.top = `${top}px`;
}

sugEl.addEventListener("mousedown", (e) => {
  e.preventDefault(); // keep focus in the editor
  const li = (e.target as HTMLElement).closest<HTMLElement>("li");
  if (li) acceptSuggest(Number(li.dataset.i));
});
window.addEventListener("resize", closeSuggest);

editor.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (sug && !mod && !e.altKey) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      return moveSuggest(e.key === "ArrowDown" ? 1 : -1);
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      return acceptSuggest();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return closeSuggest();
    }
    if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) closeSuggest();
  }
  if (e.ctrlKey && e.code === "Space") {
    e.preventDefault();
    return openSuggest();
  }
  if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
    // Behave like a shell: Enter runs, unless the text before the caret
    // ends in a line continuation or an open quote.
    const before = editor.value.slice(0, editor.selectionStart);
    if (!editor.value.trim() || !tokenize(before).complete) return;
    e.preventDefault();
    run();
  } else if (e.key === "Tab" && !mod && !e.shiftKey) {
    e.preventDefault();
    document.execCommand("insertText", false, "  ");
  }
});

// ---------------------------------------------------------------- layout

function applyLayout() {
  main.style.setProperty("--editor-h", `${(layout.split * 100).toFixed(2)}%`);
  app.classList.toggle("side-open", layout.side);
}

function toggleSidebar(force?: boolean) {
  layout.side = force ?? !layout.side;
  applyLayout();
  save(K_LAYOUT, layout);
}

bar.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (t !== bar && t !== targetEl && !t.classList.contains("spacer") && !targetEl.contains(t)) return;
  e.preventDefault();
  bar.setPointerCapture(e.pointerId);
  const rect = main.getBoundingClientRect();
  const move = (ev: PointerEvent) => {
    layout.split = Math.min(0.8, Math.max(0.1, (ev.clientY - rect.top) / rect.height));
    applyLayout();
  };
  const up = () => {
    bar.removeEventListener("pointermove", move);
    bar.removeEventListener("pointerup", up);
    save(K_LAYOUT, layout);
  };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", up);
});
bar.addEventListener("dblclick", (e) => {
  if (e.target === bar || (e.target as HTMLElement).classList.contains("spacer")) {
    layout.split = 0.38;
    applyLayout();
    save(K_LAYOUT, layout);
  }
});

// ---------------------------------------------------------------- running

let current: { id: string; timer: number } | null = null;
let view: View | null = null;
let tab: Tab = "body";
let bodyMode: "pretty" | "raw" = "pretty";
let activeHistory: string | null = null;

function setRunning(on: boolean) {
  app.classList.toggle("running", on);
  runBtn.classList.toggle("cancel", on);
  runBtn.querySelector(".label")!.textContent = on ? "Cancel" : "Send";
  $("run-kbd").textContent = on ? "Esc" : "↵";
  runBtn.title = on ? "Cancel (Esc)" : `Send (Enter or ${MOD}+Enter)`;
}

async function run() {
  if (current) return;
  const text = editor.value.trim();
  if (!text) {
    editor.focus();
    return;
  }
  const tk = tokenize(text);
  if (!tk.complete) return toast(tk.error ?? "The command looks incomplete");
  const req = prepare(tk.tokens);
  if (req.error) return toast(req.error);

  const id = uid();
  const started = performance.now();
  const timer = window.setInterval(() => {
    const el = document.getElementById("elapsed");
    if (el) el.textContent = ((performance.now() - started) / 1000).toFixed(1) + "s";
  }, 100);
  current = { id, timer };
  setRunning(true);
  renderPending(req);

  try {
    const res = await call<CurlResult>("run_curl", { id, args: req.args });
    view = buildView(req, res);
    if (view.status === 0 && res.exitCode !== 0) renderCurlError(res);
    else renderResponse();
    addHistory(text, req, view.status, view.ms);
  } catch (err) {
    const msg = String(err);
    if (msg === "cancelled") renderNotice("Request cancelled", "Press Enter to send it again.");
    else if (msg === NO_BACKEND) renderFailure("No backend", msg);
    else renderFailure("Couldn't run curl", msg);
  } finally {
    clearInterval(timer);
    current = null;
    setRunning(false);
  }
}

function cancel() {
  if (current) call("cancel_curl", { id: current.id }).catch(() => {});
}

runBtn.addEventListener("click", () => (current ? cancel() : run()));

function parseMeta(stdout: string): Meta {
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  try {
    return lines.length ? (JSON.parse(lines[lines.length - 1]) as Meta) : {};
  } catch {
    return {};
  }
}

function parseHeaders(raw: string) {
  const blocks = raw
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter((b) => /^HTTP\//i.test(b));
  const last = blocks[blocks.length - 1] ?? "";
  const [statusLine = "", ...lines] = last.split(/\r?\n/);
  const m = /^(HTTP\/[\d.]+)\s+(\d{3})\s*(.*)$/i.exec(statusLine);
  const headers: [string, string][] = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i > 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return {
    version: m?.[1] ?? "",
    status: m ? Number(m[2]) : 0,
    reason: m?.[3] ?? "",
    headers,
  };
}

function buildView(req: Prepared, res: CurlResult): View {
  const meta = parseMeta(res.meta);
  const h = parseHeaders(res.headers);
  const status = meta.response_code || h.status;
  const contentType = (
    meta.content_type ??
    h.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ??
    ""
  ).toLowerCase();

  let kind: BodyKind;
  let pretty: string | null = null;
  if (res.bodySize === 0) kind = "empty";
  else if (res.bodyEncoding === "base64") kind = contentType.startsWith("image/") ? "image" : "binary";
  else if (contentType.includes("json") || /^\s*[[{]/.test(res.body)) {
    pretty = res.body.length < 20_000_000 ? prettyJson(res.body) : null;
    kind = pretty !== null ? "json" : contentType.includes("html") ? "html" : "text";
  } else if (contentType.includes("html")) kind = "html";
  else if (contentType.includes("xml") || contentType.includes("svg")) kind = "xml";
  else kind = "text";

  const versionLabel = h.version
    ? h.version.toUpperCase()
    : meta.http_version
      ? `HTTP/${meta.http_version}`
      : "";
  return {
    req,
    res,
    meta,
    status,
    reason: h.reason || REASONS[status] || "",
    httpVersion: versionLabel,
    headers: h.headers,
    contentType,
    kind,
    pretty,
    ms: meta.time_total !== undefined ? meta.time_total * 1000 : res.elapsedMs,
  };
}

// ---------------------------------------------------------------- response rendering

function renderEmpty() {
  view = null;
  responseEl.innerHTML = `
    <div class="empty">
      <h2>Paste a cURL command and press Enter.</h2>
      <p>Copy as cURL from DevTools, API docs, or your terminal. It runs exactly as written.</p>
      <div class="keys">
        <span><kbd>↵</kbd></span><span>Send</span>
        <span><kbd>Shift</kbd> <kbd>↵</kbd></span><span>New line</span>
        <span><kbd>Esc</kbd></span><span>Cancel request</span>
        <span><kbd>${MOD}</kbd> <kbd>L</kbd></span><span>Focus command</span>
        <span><kbd>${MOD}</kbd> <kbd>Shift</kbd> <kbd>F</kbd></span><span>Format command</span>
        <span><kbd>${MOD}</kbd> <kbd>B</kbd></span><span>Toggle history</span>
      </div>
      <button class="link-btn" id="example">Try an example</button>
    </div>`;
  $("example").addEventListener("click", () => {
    setEditor(
      "curl 'https://api.github.com/repos/curl/curl' \\\n  -H 'Accept: application/vnd.github+json'",
    );
    run();
  });
}

function renderPending(req: Prepared) {
  const u = splitUrl(req.url);
  responseEl.innerHTML = `
    <div class="pending">
      <b id="elapsed">0.0s</b>
      <span>${esc(req.method)} ${esc(u.host || req.url)}</span>
    </div>`;
}

function renderNotice(title: string, text: string) {
  responseEl.innerHTML = `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
}

function renderFailure(title: string, detail: string, hint = "") {
  responseEl.innerHTML = `
    <div class="r-body">
      <div class="error-card">
        <h3>${esc(title)}</h3>
        ${hint ? `<p>${esc(hint)}</p>` : ""}
        <pre>${esc(detail.trim())}</pre>
      </div>
    </div>`;
}

function renderCurlError(res: CurlResult) {
  const code = res.exitCode ?? -1;
  const [title, hint] = CURL_ERRORS[code] ?? [`curl exited with code ${code}`];
  renderFailure(title, res.stderr || `exit code ${code}`, hint ?? "");
}

function renderResponse() {
  if (!view) return renderEmpty();
  const v = view;
  const sizeLabel = fmtBytes(v.res.bodySize);
  const redirects = v.meta.num_redirects ?? 0;

  const modeSwitch =
    tab === "body" && (v.kind === "json" || v.kind === "html")
      ? `<div class="tabs" data-modes>
           <button data-mode="pretty" class="${bodyMode === "pretty" ? "on" : ""}">${v.kind === "json" ? "Pretty" : "Source"}</button>
           <button data-mode="raw" class="${bodyMode === "raw" ? "on" : ""}">${v.kind === "json" ? "Raw" : "Preview"}</button>
         </div>`
      : "";

  responseEl.innerHTML = `
    <div class="r-head">
      <span class="status ${statusClass(v.status)}">${v.status || "-"} <span class="reason">${esc(v.reason)}</span></span>
      <span class="stat"><b>${fmtMs(v.ms)}</b></span>
      <span class="stat"><b>${sizeLabel}</b></span>
      ${v.httpVersion ? `<span class="stat">${esc(v.httpVersion)}</span>` : ""}
      ${redirects ? `<span class="stat" title="Redirects followed">↪ ${redirects}</span>` : ""}
      <span class="spacer"></span>
      ${modeSwitch}
      <div class="tabs" data-tabs>
        <button data-tab="body" class="${tab === "body" ? "on" : ""}">Body</button>
        <button data-tab="headers" class="${tab === "headers" ? "on" : ""}">Headers<span class="count">${v.headers.length}</span></button>
        <button data-tab="timing" class="${tab === "timing" ? "on" : ""}">Timing</button>
      </div>
      <button class="ghost small" id="copy-body" title="Copy (${MOD}+Shift+C)">Copy</button>
    </div>
    <div class="r-body" id="r-body"></div>`;

  const body = $("r-body");
  const banner = v.res.stderr.trim()
    ? `<div class="banner">${esc(v.res.stderr.trim())}</div>`
    : "";
  if (tab === "headers") body.innerHTML = banner + renderHeaders(v);
  else if (tab === "timing") body.innerHTML = banner + renderTiming(v);
  else renderBody(body, v, banner);

  responseEl.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.tab as Tab)),
  );
  responseEl.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      bodyMode = b.dataset.mode as "pretty" | "raw";
      renderResponse();
    }),
  );
  $("copy-body").addEventListener("click", copyResponse);
}

const HIGHLIGHT_LIMIT = 3_000_000;
const DISPLAY_LIMIT = 8_000_000;

function renderBody(el: HTMLElement, v: View, banner: string) {
  const { res } = v;
  let note = res.truncated ? `<div class="note">Showing the first 32 MB of ${fmtBytes(res.bodySize)}.</div>` : "";
  const clip = (s: string) => {
    if (s.length <= DISPLAY_LIMIT) return s;
    note += `<div class="note">Display limited to the first ${fmtBytes(DISPLAY_LIMIT)}. Copy gets everything.</div>`;
    return s.slice(0, DISPLAY_LIMIT);
  };

  switch (v.kind) {
    case "empty":
      el.innerHTML = banner + `<div class="empty"><p>No response body</p></div>`;
      return;
    case "image":
      el.innerHTML =
        banner + `<div class="image-wrap"><img alt="Response image" src="data:${esc(v.contentType)};base64,${res.body}" /></div>`;
      return;
    case "binary":
      el.innerHTML =
        banner +
        `<div class="empty"><h2>Binary response</h2><p>${fmtBytes(res.bodySize)} · ${esc(v.contentType || "unknown type")}</p></div>`;
      return;
    case "json": {
      const text = clip(bodyMode === "pretty" && v.pretty ? v.pretty : res.body);
      const html = text.length < HIGHLIGHT_LIMIT ? highlightJson(text) : esc(text);
      el.innerHTML = banner + note + `<pre class="code">${html}</pre>`;
      return;
    }
    case "html":
      if (bodyMode === "raw") {
        el.innerHTML = banner;
        const frame = document.createElement("iframe");
        frame.className = "preview";
        frame.setAttribute("sandbox", "");
        frame.title = "HTML preview";
        const base = v.meta.url_effective ? `<base href="${esc(v.meta.url_effective)}">` : "";
        frame.srcdoc = base + res.body;
        el.append(frame);
        return;
      }
    // fall through: source view
    case "xml": {
      const text = clip(res.body);
      el.innerHTML =
        banner + note + `<pre class="code">${text.length < HIGHLIGHT_LIMIT ? highlightMarkup(text) : esc(text)}</pre>`;
      return;
    }
    default:
      el.innerHTML = banner + note + `<pre class="code">${esc(clip(res.body))}</pre>`;
  }
}

function renderHeaders(v: View) {
  const row = (k: string, val: string) =>
    `<div class="k">${esc(k)}</div><div class="v" data-copy>${esc(val)}</div>`;
  const m = v.meta;
  const command = ["curl", ...v.req.args].map((a, i) => (i ? shellQuote(a) : a)).join(" ");
  return `
    <div class="kv">
      <div class="sec">Response headers</div>
      ${v.headers.map(([k, val]) => row(k, val)).join("") || `<div class="k">-</div><div class="v"></div>`}
      <div class="sec">Request</div>
      ${row("Method", v.req.method)}
      ${row("URL", m.url_effective || v.req.url)}
      ${m.remote_ip ? row("Remote address", `${m.remote_ip}${m.remote_port ? ":" + m.remote_port : ""}`) : ""}
      ${v.httpVersion ? row("Protocol", v.httpVersion) : ""}
      ${m.num_redirects ? row("Redirects", String(m.num_redirects)) : ""}
      ${row("Command", command)}
    </div>`;
}

function renderTiming(v: View) {
  const m = v.meta;
  const s = (x?: number) => (x ?? 0) * 1000;
  const total = s(m.time_total) || v.ms;
  const dns = s(m.time_namelookup);
  const conn = Math.max(dns, s(m.time_connect));
  const tls = s(m.time_appconnect);
  const pre = Math.max(conn, tls, s(m.time_pretransfer));
  const first = Math.max(pre, s(m.time_starttransfer));
  const redirect = s(m.time_redirect);

  const rows: [string, number, number, string][] = [];
  if (redirect > 0) rows.push(["Redirects", 0, redirect, "var(--s3)"]);
  rows.push(["DNS lookup", 0, dns, "var(--put)"]);
  rows.push(["TCP connect", dns, conn, "var(--post)"]);
  if (tls > 0) rows.push(["TLS handshake", conn, Math.max(conn, tls), "var(--patch)"]);
  rows.push(["Waiting (TTFB)", pre, first, "var(--accent)"]);
  rows.push(["Download", first, total, "var(--get)"]);

  const pct = (x: number) => (total > 0 ? (Math.min(x, total) / total) * 100 : 0);
  return `
    <div class="timing">
      ${rows
        .map(
          ([label, a, b, c]) => `
        <div class="t-row">
          <span class="lbl">${label}</span>
          <div class="t-track"><div class="t-bar" style="--c:${c};left:${pct(a)}%;width:${Math.max(0, pct(b) - pct(a))}%"></div></div>
          <span class="ms">${fmtMs(Math.max(0, b - a))}</span>
        </div>`,
        )
        .join("")}
      <div class="t-row total"><span class="lbl">Total</span><span></span><span class="ms">${fmtMs(total)}</span></div>
    </div>`;
}

function setTab(t: Tab) {
  tab = t;
  if (view && view.status) renderResponse();
}

function copyResponse() {
  if (!view) return;
  if (tab === "headers") {
    copy(view.headers.map(([k, v]) => `${k}: ${v}`).join("\n"), "Headers copied");
  } else {
    const text = view.kind === "json" && bodyMode === "pretty" && view.pretty ? view.pretty : view.res.body;
    copy(text, "Response copied");
  }
}

responseEl.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
  if (t && !window.getSelection()?.toString()) copy(t.textContent ?? "", "Value copied");
});

// ---------------------------------------------------------------- history

function addHistory(cmd: string, req: Prepared, status: number, ms: number) {
  history = history.filter((h) => h.cmd !== cmd);
  const entry: HistoryEntry = { id: uid(), cmd, method: req.method, url: req.url, status, ms, ts: Date.now() };
  history.unshift(entry);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  activeHistory = entry.id;
  save(K_HISTORY, history);
  renderHistory();
}

function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= start) return "Today";
  if (ts >= start - 86_400_000) return "Yesterday";
  if (ts >= start - 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function renderHistory() {
  const q = searchEl.value.trim().toLowerCase();
  const items = q ? history.filter((h) => h.cmd.toLowerCase().includes(q)) : history;
  if (!items.length) {
    historyEl.innerHTML = `<li class="h-empty">${q ? "No matches" : "Requests you send show up here"}</li>`;
    return;
  }
  let html = "";
  let group = "";
  for (const h of items) {
    const g = dayLabel(h.ts);
    if (g !== group) {
      group = g;
      html += `<li class="h-group">${esc(g)}</li>`;
    }
    const u = splitUrl(h.url);
    const time = new Date(h.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    html += `
      <li class="h-item${h.id === activeHistory ? " active" : ""}" data-id="${h.id}" role="option" title="${esc(h.url)}">
        <span class="method m-${esc(h.method)}">${esc(h.method)}</span>
        <span class="h-path">${esc(u.path + u.query || "/")}</span>
        <span class="h-status ${statusClass(h.status)}">${h.status || "ERR"}</span>
        <span class="h-host">${esc(u.host)} · ${time}${h.ms ? " · " + fmtMs(h.ms) : ""}</span>
        <button class="h-del" title="Remove" aria-label="Remove">×</button>
      </li>`;
  }
  historyEl.innerHTML = html;
}

historyEl.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const item = target.closest<HTMLElement>(".h-item");
  if (!item) return;
  const id = item.dataset.id!;
  if (target.closest(".h-del")) {
    history = history.filter((h) => h.id !== id);
    save(K_HISTORY, history);
    renderHistory();
    return;
  }
  const entry = history.find((h) => h.id === id);
  if (!entry) return;
  activeHistory = id;
  setEditor(entry.cmd);
  renderHistory();
});
historyEl.addEventListener("dblclick", (e) => {
  if ((e.target as HTMLElement).closest(".h-item") && !(e.target as HTMLElement).closest(".h-del")) run();
});
searchEl.addEventListener("input", renderHistory);
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchEl.value = "";
    renderHistory();
    editor.focus();
  } else if (e.key === "Enter") {
    const first = history.find((h) => h.cmd.toLowerCase().includes(searchEl.value.trim().toLowerCase()));
    if (first) {
      activeHistory = first.id;
      setEditor(first.cmd);
      renderHistory();
    }
  }
});
$("clear-history").addEventListener("click", () => {
  if (!history.length) return;
  const previous = history;
  history = [];
  save(K_HISTORY, history);
  renderHistory();
  toastWithUndo(previous);
});

function toastWithUndo(previous: HistoryEntry[]) {
  toastEl.innerHTML = `History cleared · <button class="link-btn" style="pointer-events:auto">Undo</button>`;
  toastEl.classList.add("show");
  toastEl.querySelector("button")!.addEventListener("click", () => {
    history = previous;
    save(K_HISTORY, history);
    renderHistory();
    toastEl.classList.remove("show");
  });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 5000);
}

// ---------------------------------------------------------------- commands

function formatEditor() {
  const text = editor.value.trim();
  if (!text) return;
  const tk = tokenize(text);
  if (!tk.complete) return toast(tk.error ?? "The command looks incomplete");
  setEditor(formatCommand(tk.tokens, !text.includes("\n")));
}

function newRequest() {
  setEditor("");
  activeHistory = null;
  renderHistory();
  renderEmpty();
}

$("format").addEventListener("click", formatEditor);
$("copy-cmd").addEventListener("click", () => editor.value.trim() && copy(editor.value.trim(), "Command copied"));
$("toggle-side").addEventListener("click", () => toggleSidebar());

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (e.key === "Escape" && current) {
    e.preventDefault();
    cancel();
  } else if (mod && e.key === "Enter") {
    e.preventDefault();
    current ? cancel() : run();
  } else if (mod && key === "l") {
    e.preventDefault();
    editor.focus();
    editor.select();
  } else if (mod && key === "b") {
    e.preventDefault();
    toggleSidebar();
  } else if (mod && key === "k") {
    e.preventDefault();
    toggleSidebar(true);
    searchEl.focus();
    searchEl.select();
  } else if (mod && key === "n") {
    e.preventDefault();
    newRequest();
  } else if (mod && e.shiftKey && key === "f") {
    e.preventDefault();
    formatEditor();
  } else if (mod && e.shiftKey && key === "c") {
    e.preventDefault();
    copyResponse();
  } else if (mod && !e.shiftKey && (key === "1" || key === "2" || key === "3")) {
    e.preventDefault();
    setTab((["body", "headers", "timing"] as const)[Number(key) - 1]);
  }
});

// Keep the browser's own page-level shortcuts (reload, zoom reset…) from surprising anyone.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("textarea, input, .code, .kv, .error-card, .banner")) e.preventDefault();
});

// Flush the debounced draft when the window closes or hides.
const flushDraft = () => {
  clearTimeout(draftTimer);
  save(K_DRAFT, editor.value);
};
window.addEventListener("pagehide", flushDraft);
window.addEventListener("beforeunload", flushDraft);
document.addEventListener("visibilitychange", () => document.hidden && flushDraft());

// ---------------------------------------------------------------- boot

app.classList.add("no-anim");
applyLayout();
requestAnimationFrame(() => app.classList.remove("no-anim"));
editor.value = load<string>(K_DRAFT, "");
refresh();
renderHistory();
renderEmpty();
editor.focus();
editor.setSelectionRange(editor.value.length, editor.value.length);

call<string>("curl_version")
  .then((v) => {
    $("curl-version").textContent = v.split(" ").slice(0, 2).join(" ") || "curl";
    $("curl-version").title = v;
  })
  .catch(() => {
    $("curl-version").textContent = "backend unavailable";
  });
