import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runCurl, cancelCurl, curlVersion, encodeBody, handleBridge } from "./dev-bridge.ts";
import { startTestServer, BIG_JSON, PNG } from "./test-server.ts";
import { tokenize, prepare } from "../src/parse.ts";

let srv: Awaited<ReturnType<typeof startTestServer>>;
before(async () => (srv = await startTestServer()));
after(() => srv.close());

let n = 0;
const id = () => `t${Date.now()}${n++}`;
/** Runs a command the way the UI does: tokenize → prepare → curl. */
const run = (cmd: string) => runCurl(id(), prepare(tokenize(cmd.replaceAll("$URL", srv.url)).tokens).args);
const meta = (stdout: string) => JSON.parse(stdout.trim().split("\n").pop()!);

test("curl is available", async () => {
  assert.match(await curlVersion(), /^curl \d+\.\d+/);
});

test("GET JSON: status, headers, body and timing metadata", async () => {
  const r = await run("curl $URL/json");
  assert.equal(r.exitCode, 0);
  assert.equal(r.body, BIG_JSON);
  assert.equal(r.bodyEncoding, "utf8");
  assert.equal(r.bodySize, Buffer.byteLength(BIG_JSON));
  assert.match(r.headers, /^HTTP\/1\.1 200 OK/);
  assert.match(r.headers, /x-test: yes/i);
  const m = meta(r.meta);
  assert.equal(m.response_code, 200);
  assert.equal(typeof m.time_total, "number");
});

test("POST with headers and multi-line body from a pasted command", async () => {
  const r = await run(`curl '$URL/echo?x=1' \\
    -H 'Authorization: Bearer TOKEN' \\
    -H 'Content-Type: application/json' \\
    -d '{"name":"John"}'`);
  const echo = JSON.parse(r.body);
  assert.equal(echo.method, "POST");
  assert.equal(echo.query, "?x=1");
  assert.equal(echo.headers.authorization, "Bearer TOKEN");
  assert.equal(echo.body, '{"name":"John"}');
});

test("explicit method, -sSL bundles and stripped output flags", async () => {
  const r = await run("curl -sSLi -o out.json -XPUT $URL/echo --data-raw abc -w '%{http_code}'");
  assert.equal(r.exitCode, 0);
  const echo = JSON.parse(r.body);
  assert.equal(echo.method, "PUT");
  assert.equal(echo.body, "abc");
});

test("follows redirects with -L (all hops in headers, final status in meta)", async () => {
  const r = await run("curl -L $URL/redirect");
  assert.equal(meta(r.meta).response_code, 200);
  assert.equal(meta(r.meta).num_redirects, 1);
  assert.match(r.headers, /302/);
  assert.equal(r.body, BIG_JSON);
});

test("HTTP errors are responses, not curl failures", async () => {
  const r = await run("curl -f '$URL/status?code=503'");
  assert.equal(r.exitCode, 0, "-f is stripped so the body is still shown");
  assert.equal(meta(r.meta).response_code, 503);
  assert.equal(r.body, "status 503");
});

test("204 has an empty body", async () => {
  const r = await run("curl $URL/empty");
  assert.equal(r.bodySize, 0);
  assert.equal(meta(r.meta).response_code, 204);
});

test("binary bodies are base64, UTF-8 text stays text", async () => {
  const img = await run("curl $URL/image");
  assert.equal(img.bodyEncoding, "base64");
  assert.deepEqual(Buffer.from(img.body, "base64"), PNG);
  const bin = await run("curl $URL/binary");
  assert.equal(bin.bodyEncoding, "base64");
  const uni = await run("curl $URL/unicode");
  assert.equal(uni.body, "héllo € 日本");
});

test("connection refused reports curl's error", async () => {
  const r = await run("curl http://127.0.0.1:9/");
  assert.equal(r.exitCode, 7);
  assert.match(r.stderr, /curl: \(7\)/);
});

test("cancel kills the request", async () => {
  const rid = id();
  const p = runCurl(rid, [`${srv.url}/slow?ms=10000`]);
  setTimeout(() => cancelCurl(rid), 300);
  const t0 = Date.now();
  await assert.rejects(p, (e) => e === "cancelled");
  assert.ok(Date.now() - t0 < 3000);
});

test("missing curl binary gives a helpful error", async () => {
  await assert.rejects(runCurl(id(), ["x"], "definitely-not-curl-xyz"), /Could not start curl/);
});

test("encodeBody keeps UTF-8 cut mid-character as text", () => {
  const buf = Buffer.from("ab€", "utf8");
  assert.deepEqual(encodeBody(buf.subarray(0, buf.length - 1)), { body: "ab", bodyEncoding: "utf8" });
  assert.equal(encodeBody(Buffer.from([0xff, 0x00])).bodyEncoding, "base64");
});

test("HTTP endpoint: serves same-origin calls, rejects cross-site ones", async () => {
  const server: Server = createServer((q, s) => handleBridge(q, s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const ok = await post("/run_curl", { id: id(), args: [`${srv.url}/json`] }, { "x-curlman": "1" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).body, BIG_JSON);

    assert.equal((await post("/run_curl", { id: "a", args: [] })).status, 403, "missing header");
    assert.equal(
      (await post("/run_curl", { id: "a", args: [] }, { "x-curlman": "1", origin: "https://evil.example" })).status,
      403,
      "foreign origin",
    );
    assert.equal((await post("/run_curl", { id: 1, args: "x" }, { "x-curlman": "1" })).status, 400);
    assert.equal((await post("/nope", {}, { "x-curlman": "1" })).status, 404);
    const v = await post("/curl_version", {}, { "x-curlman": "1" });
    assert.match(await v.json(), /^curl /);
  } finally {
    server.close();
  }
});
