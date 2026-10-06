// End-to-end tests: drive the real UI and real curl against a local test server.
//
//   desktop  the built Tauri app (Windows: attaches to WebView2 over CDP).
//            Build first with `npm run tauri build`; skipped if the binary is missing.
//   browser  `npm run dev` mode (Vite dev server + /__curlman bridge) in headless Chrome/Edge.
//   static   the production bundle opened without any backend: must explain, not crash.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, extname } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { startTestServer, BIG_JSON } from "./test-server.ts";

const ROOT = join(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findBrowser(): string {
  const candidates = [
    process.env.CURLMAN_E2E_BROWSER,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("No Chrome/Edge found; set CURLMAN_E2E_BROWSER");
  return found;
}

let srv: Awaited<ReturnType<typeof startTestServer>>;
before(async () => (srv = await startTestServer()));
after(() => srv.close());

// ---------------------------------------------------------------- helpers

/** Replaces the editor content the way a paste does. */
async function paste(page: Page, text: string) {
  await page.evaluate((t) => {
    const e = document.getElementById("editor") as HTMLTextAreaElement;
    e.focus();
    e.select();
    document.execCommand("insertText", false, t);
  }, text.replaceAll("$URL", srv.url));
}

async function send(page: Page, cmd: string) {
  await paste(page, cmd);
  await page.keyboard.press("Enter");
  await waitIdle(page);
}

async function waitIdle(page: Page) {
  await page.waitForFunction(() => !document.getElementById("app")!.classList.contains("running"), {
    timeout: 20_000,
  });
}

const text = (page: Page, sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText);

async function resetApp(page: Page) {
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#editor");
}

// ---------------------------------------------------------------- shared scenarios

function scenarios(getPage: () => Page) {
  test("boots with the empty state and finds curl", async () => {
    const page = getPage();
    await resetApp(page);
    assert.match(await text(page, "#response"), /Paste a cURL command and press Enter/);
    await page.waitForFunction(() => /^curl \d/.test(document.getElementById("curl-version")!.textContent ?? ""));
  });

  test("typing: Enter after a backslash continues the line, Enter at the end sends", async () => {
    const page = getPage();
    await paste(page, "");
    await page.keyboard.type(`curl '${srv.url}/json' \\`);
    await page.keyboard.press("Enter");
    await page.keyboard.type("  -H 'Accept: application/json'");
    assert.equal(
      await page.$eval("#editor", (e) => (e as HTMLTextAreaElement).value),
      `curl '${srv.url}/json' \\\n  -H 'Accept: application/json'`,
    );
    assert.equal(await text(page, "#method"), "GET");
    await page.keyboard.press("Enter");
    await waitIdle(page);
    assert.match(await text(page, ".status"), /200\s+OK/);
    const body = await text(page, ".code");
    assert.match(body, /"id": 12345678901234567890/, "big integers are not rounded");
    assert.match(body, /"nested": \{\n\s+"ok": true/);
  });

  test("Raw view shows the body byte-for-byte", async () => {
    const page = getPage();
    await page.click('[data-mode="raw"]');
    assert.equal(await text(page, ".code"), BIG_JSON);
    await page.click('[data-mode="pretty"]');
  });

  test("Headers and Timing tabs", async () => {
    const page = getPage();
    await page.click('[data-tab="headers"]');
    const h = await text(page, ".kv");
    assert.match(h, /x-test\s+yes/i);
    assert.match(h, /Command\s+curl/);
    await page.click('[data-tab="timing"]');
    assert.match(await text(page, ".timing"), /DNS lookup[\s\S]*Total/);
    await page.click('[data-tab="body"]');
  });

  test("pasted multi-line POST with headers and JSON body", async () => {
    const page = getPage();
    await send(
      page,
      `curl '$URL/echo' \\
  -H 'Authorization: Bearer TOKEN' \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"John"}'`,
    );
    assert.equal(await text(page, "#method"), "POST");
    const echo = JSON.parse(await page.$eval(".code", (e) => e.textContent!));
    assert.equal(echo.method, "POST");
    assert.equal(echo.headers.authorization, "Bearer TOKEN");
    assert.equal(echo.body, '{"name":"John"}');
  });

  test("Chrome 'Copy as cURL (cmd)' syntax", async () => {
    const page = getPage();
    await send(page, `curl ^"$URL/echo^" ^\n  -H ^"x-a: 1^" ^\n  --data-raw ^"^{^\\^"k^\\^":1^}^"`);
    const echo = JSON.parse(await page.$eval(".code", (e) => e.textContent!));
    assert.equal(echo.headers["x-a"], "1");
    assert.equal(echo.body, '{"k":1}');
  });

  test("Ctrl+Enter sends from anywhere; status colours for 4xx", async () => {
    const page = getPage();
    await paste(page, "curl '$URL/status?code=404'");
    await page.click("#response");
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
    await waitIdle(page);
    assert.match(await text(page, ".status"), /404\s+Not Found/);
    assert.ok(await page.$(".status.s4"));
  });

  test("redirects, empty bodies, HTML preview, images, binary", async () => {
    const page = getPage();
    await send(page, "curl -L $URL/redirect");
    assert.match(await text(page, ".r-head"), /200[\s\S]*↪ 1/);

    await send(page, "curl $URL/empty");
    assert.match(await text(page, "#r-body"), /No response body/);

    await send(page, "curl $URL/html");
    assert.match(await text(page, ".code"), /<h1 class="x">Hello Curlman<\/h1>/);
    await page.click('[data-mode="raw"]');
    const frame = await page.waitForSelector("iframe.preview");
    assert.equal(await frame!.evaluate((f) => f.getAttribute("sandbox")), "", "preview is sandboxed");

    await send(page, "curl $URL/image");
    const ok = await page.$eval("#r-body img", (img) =>
      (img as HTMLImageElement).decode().then(() => (img as HTMLImageElement).naturalWidth),
    );
    assert.equal(ok, 1);

    await send(page, "curl $URL/binary");
    assert.match(await text(page, "#r-body"), /Binary response/);

    await send(page, "curl $URL/unicode");
    assert.equal(await text(page, ".code"), "héllo € 日本");
  });

  test("curl failures show a readable error", async () => {
    const page = getPage();
    await send(page, "curl http://127.0.0.1:9/");
    assert.match(await text(page, ".error-card"), /Couldn't connect[\s\S]*curl: \(7\)/);
  });

  test("incomplete commands are not sent", async () => {
    const page = getPage();
    await paste(page, "curl '$URL/json");
    await page.keyboard.press("Enter");
    assert.equal(
      await page.$eval("#editor", (e) => (e as HTMLTextAreaElement).value),
      `curl '${srv.url}/json\n`,
      "Enter inside an open quote inserts a newline",
    );
    await paste(page, "curl -H");
    await page.waitForFunction(() => /needs a value/.test(document.getElementById("target")!.textContent ?? ""), {
      timeout: 2000,
    });
    assert.equal(await page.$eval("#target", (e) => e.className), "error");
  });

  test("Esc cancels a running request", async () => {
    const page = getPage();
    await paste(page, "curl '$URL/slow?ms=10000'");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#elapsed");
    await sleep(400);
    await page.keyboard.press("Escape");
    await waitIdle(page);
    assert.match(await text(page, "#response"), /Request cancelled/);
  });

  test("Format toggles multi-line and one-line", async () => {
    const page = getPage();
    await paste(page, "curl -sSL $URL/json -H 'A: 1' --compressed");
    await page.click("#format");
    const multi = await page.$eval("#editor", (e) => (e as HTMLTextAreaElement).value);
    assert.equal(multi, `curl '${srv.url}/json' \\\n  -sSL \\\n  -H 'A: 1' \\\n  --compressed`);
    await page.click("#format");
    assert.equal(
      await page.$eval("#editor", (e) => (e as HTMLTextAreaElement).value),
      `curl '${srv.url}/json' -sSL -H 'A: 1' --compressed`,
    );
  });

  test("editor: line numbers, active line, Ln/Col, dialect", async () => {
    const page = getPage();
    await paste(page, "curl '$URL/json' \\\n  -H 'A: 1' \\\n  -L");
    await page.waitForFunction(() => document.querySelectorAll("#hl .ln").length === 3);
    assert.deepEqual(
      await page.$$eval("#hl .ln", (ls) => ls.map((l) => (l as HTMLElement).dataset.n)),
      ["1", "2", "3"],
    );
    // a quoted string spanning lines stays highlighted on both lines
    await paste(page, "curl $URL/echo -d '{\n  \"a\": 1\n}'");
    await page.waitForFunction(() => document.getElementById("hl")!.textContent!.includes('"a": 1'));
    assert.equal(await page.$$eval("#hl .ln .t-val", (s) => s.length), 3);
    await page.evaluate(() => {
      const e = document.getElementById("editor") as HTMLTextAreaElement;
      e.setSelectionRange(e.value.indexOf('"a"'), e.value.indexOf('"a"'));
      e.dispatchEvent(new Event("select"));
    });
    assert.equal(await text(page, "#ed-pos"), "Ln 2, Col 3");
    assert.equal(await page.$eval("#hl .ln.active", (l) => (l as HTMLElement).dataset.n), "2");
    assert.equal(await text(page, "#ed-dialect"), "bash");
    await paste(page, 'curl ^"$URL/json^" ^\n  -L');
    await page.waitForFunction(() => document.getElementById("ed-dialect")!.textContent === "cmd");
  });

  test("autocomplete: build a request entirely from suggestions", async () => {
    const page = getPage();
    const value = () => page.$eval("#editor", (e) => (e as HTMLTextAreaElement).value);
    const popup = () => page.$eval("#suggest", (e) => !(e as HTMLElement).hidden);
    const labels = () => page.$$eval("#suggest li .s-label", (ls) => ls.map((l) => l.textContent));

    await paste(page, "");
    await page.keyboard.type("cu");
    assert.deepEqual(await labels(), ["curl"]);
    await page.keyboard.press("Tab");
    assert.equal(await value(), "curl ");

    await page.keyboard.type(`${srv.url}/echo --head`);
    assert.equal(await popup(), false, "exact switch (--head) offers nothing");
    await page.keyboard.type("e");
    assert.equal((await labels())[0], "-H, --header");
    await page.keyboard.press("Enter"); // accepts instead of sending
    assert.equal(await value(), `curl ${srv.url}/echo --header '`);
    assert.ok((await labels()).includes("Content-Type"), "header names open right away");

    await page.keyboard.type("content-t");
    await page.keyboard.press("Tab");
    assert.equal(await value(), `curl ${srv.url}/echo --header 'Content-Type: `);
    assert.equal((await labels())[0], "application/json");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    assert.equal(await value(), `curl ${srv.url}/echo --header 'Content-Type: application/json'`);
    assert.equal(await popup(), false);

    await page.keyboard.type(" -X");
    assert.equal((await labels())[0], "-X, --request");
    await page.keyboard.press("Tab");
    assert.deepEqual(await labels(), ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
    await page.keyboard.type("pa");
    await page.click("#suggest li"); // mouse works too
    assert.equal(await value(), `curl ${srv.url}/echo --header 'Content-Type: application/json' -X PATCH `);

    await page.keyboard.type("-");
    assert.equal(await popup(), true);
    await page.keyboard.press("Escape");
    assert.equal(await popup(), false, "Esc closes suggestions");
    await page.keyboard.press("Backspace");
    await page.keyboard.down("Control");
    await page.keyboard.press("Space");
    await page.keyboard.up("Control");
    assert.equal(await popup(), false, "nothing to suggest after a complete token");

    await page.keyboard.press("Enter"); // popup closed: sends
    await waitIdle(page);
    const echo = JSON.parse(await page.$eval(".code", (e) => e.textContent!));
    assert.equal(echo.method, "PATCH");
    assert.equal(echo.headers["content-type"], "application/json");
  });

  test("history records, reloads, searches, deletes and persists", async () => {
    const page = getPage();
    const items = await page.$$(".h-item");
    assert.ok(items.length >= 8, `history has ${items.length} items`);
    assert.match(await text(page, "#history"), /\/echo/);

    await page.type("#hist-search", "status?code=404");
    assert.equal((await page.$$(".h-item")).length, 1);
    await page.click(".h-item");
    assert.equal(
      await page.$eval("#editor", (e) => (e as HTMLTextAreaElement).value),
      `curl '${srv.url}/status?code=404'`,
    );
    await page.click("#hist-search", { count: 3 });
    await page.keyboard.press("Escape");

    const before = (await page.$$(".h-item")).length;
    await page.hover(".h-item");
    await page.click(".h-item .h-del");
    assert.equal((await page.$$(".h-item")).length, before - 1);

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".h-item");
    assert.equal((await page.$$(".h-item")).length, before - 1, "history survives a restart");
    assert.equal(
      await page.$eval("#editor", (e) => (e as HTMLTextAreaElement).value),
      `curl '${srv.url}/status?code=404'`,
      "draft survives a restart",
    );
  });
}

// ---------------------------------------------------------------- targets

const exe = join(ROOT, "src-tauri/target/release", process.platform === "win32" ? "curlman.exe" : "curlman");
const desktopSkip =
  process.platform !== "win32"
    ? "desktop e2e attaches to WebView2, Windows only"
    : !existsSync(exe)
      ? "release build missing; run `npm run tauri build`"
      : false;

describe("desktop app", { skip: desktopSkip }, () => {
  let app: ChildProcess;
  let browser: Browser;
  let page: Page;
  const port = 9300 + Math.floor(Math.random() * 500);

  before(async () => {
    app = spawn(exe, [], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
      stdio: "ignore",
    });
    for (let i = 0; ; i++) {
      try {
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
        break;
      } catch (e) {
        if (i > 60) throw e;
        await sleep(250);
      }
    }
    for (let i = 0; !page; i++) {
      page = (await browser.pages()).find((p) => p.url().includes("tauri.localhost"))!;
      if (!page) await sleep(200);
      if (i > 50) throw new Error("app window not found");
    }
    assert.equal(await page.evaluate(() => "__TAURI_INTERNALS__" in window), true);
  });
  after(async () => {
    await browser?.disconnect();
    app?.kill();
  });

  scenarios(() => page);
});

describe("browser (npm run dev)", () => {
  let vite: ViteDevServer;
  let browser: Browser;
  let page: Page;

  before(async () => {
    vite = await createViteServer({
      root: ROOT,
      configFile: join(ROOT, "vite.config.ts"),
      server: { port: 0, strictPort: false, host: "127.0.0.1" },
      logLevel: "error",
    });
    await vite.listen();
    const { port } = vite.httpServer!.address() as AddressInfo;
    browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true });
    page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
    assert.deepEqual(errors, []);
  });
  after(async () => {
    await browser?.close();
    await vite?.close();
  });

  scenarios(() => page);
});

describe("static bundle without a backend", () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  const dist = join(ROOT, "dist");
  const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

  before(async () => {
    assert.ok(existsSync(join(dist, "index.html")), "run `npm run build` first");
    server = createHttpServer((req, res) => {
      const path = join(dist, req.url === "/" ? "index.html" : (req.url ?? "").split("?")[0]);
      if (!path.startsWith(dist) || !existsSync(path)) {
        res.writeHead(404, { "content-type": "text/html" });
        return res.end("<h1>404</h1>");
      }
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
      res.end(readFileSync(path));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { waitUntil: "load" });
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  test("explains how to run instead of throwing", async () => {
    await page.waitForFunction(() => document.getElementById("curl-version")!.textContent === "backend unavailable");
    await send(page, "curl $URL/json");
    const card = await text(page, ".error-card");
    assert.match(card, /No backend/);
    assert.match(card, /npm run dev/);
    assert.doesNotMatch(card, /TypeError/);
  });
});
