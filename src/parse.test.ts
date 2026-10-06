import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, prepare, formatCommand } from "./parse.ts";

const argv = (s: string) => tokenize(s).tokens;

test("bash: multi-line with quotes and continuations", () => {
  const src = `curl 'https://api.example.com/users' \\
  -H 'Authorization: Bearer TOKEN' \\
  -H "Content-Type: application/json" \\
  -d '{"name":"John"}'`;
  assert.deepEqual(argv(src), [
    "curl", "https://api.example.com/users",
    "-H", "Authorization: Bearer TOKEN",
    "-H", "Content-Type: application/json",
    "-d", '{"name":"John"}',
  ]);
  assert.equal(tokenize(src).complete, true);
});

test("bash: trailing spaces after backslash still continue the line", () => {
  assert.deepEqual(argv("curl x \\   \n  -I"), ["curl", "x", "-I"]);
});

test("bash: CRLF line endings", () => {
  assert.deepEqual(argv("curl x \\\r\n  -I\r\n"), ["curl", "x", "-I"]);
});

test("bash: incomplete input", () => {
  assert.equal(tokenize("curl x \\").complete, false);
  assert.equal(tokenize("curl x \\\n").complete, false);
  assert.equal(tokenize("curl 'x").complete, false);
  assert.equal(tokenize('curl "x').complete, false);
});

test("bash: double-quote escapes and $'' strings", () => {
  assert.deepEqual(argv(`curl -d "a \\"b\\" \\$c \\n"`), ["curl", "-d", 'a "b" $c \\n']);
  assert.deepEqual(argv(`curl --data-raw $'{"a":"it\\'s\\n\\u00e9\\xe2\\x82\\xac"}'`), [
    "curl", "--data-raw", `{"a":"it's\né€"}`,
  ]);
});

test("bash: adjacent quoting concatenates", () => {
  assert.deepEqual(argv(`curl -H 'a: '"b"c`), ["curl", "-H", "a: bc"]);
});

test("cmd: Chrome 'Copy as cURL (cmd)' format", () => {
  const src = `curl ^"https://api.example.com/x?a=1^&b=2^" ^
  -H ^"accept: */*^" ^
  --data-raw ^"^{^\\^"name^\\^":^\\^"John^\\^"^}^" ^
  --compressed`;
  assert.deepEqual(argv(src), [
    "curl", "https://api.example.com/x?a=1&b=2",
    "-H", "accept: */*",
    "--data-raw", '{"name":"John"}',
    "--compressed",
  ]);
  assert.equal(tokenize(src).dialect, "cmd");
  assert.equal(tokenize("curl ^\"x^\" ^\n").complete, false);
});

test("prepare: infers method and strips output flags", () => {
  const p = prepare(argv(`curl -sSL -i -o out.json -w '%{http_code}' https://x.dev -d a=1`));
  assert.equal(p.method, "POST");
  assert.equal(p.url, "https://x.dev");
  assert.deepEqual(p.args, ["-L", "https://x.dev", "-d", "a=1"]);
});

test("prepare: attached short values and explicit method", () => {
  const p = prepare(argv(`curl -XDELETE -H'X-A: 1' https://x.dev/1`));
  assert.equal(p.method, "DELETE");
  assert.deepEqual(p.args, ["-X", "DELETE", "-H", "X-A: 1", "https://x.dev/1"]);
});

test("prepare: HEAD, GET with data, upload, --url", () => {
  assert.equal(prepare(argv("curl -I x")).method, "HEAD");
  assert.equal(prepare(argv("curl -G -d a=1 x")).method, "GET");
  assert.equal(prepare(argv("curl -T f.txt x")).method, "PUT");
  assert.equal(prepare(argv("curl --url https://y.dev")).url, "https://y.dev");
});

test("prepare: works without the curl prefix and with a $ prompt", () => {
  assert.equal(prepare(argv("https://x.dev")).url, "https://x.dev");
  assert.deepEqual(prepare(argv("$ curl https://x.dev")).args, ["https://x.dev"]);
});

test("prepare: values that look like flags are not parsed as flags", () => {
  const p = prepare(argv(`curl -d -v -H '-i' x`));
  assert.deepEqual(p.args, ["-d", "-v", "-H", "-i", "x"]);
});

test("prepare: reports missing values / URL", () => {
  assert.match(prepare(argv("curl x -H")).error!, /needs a value/);
  assert.equal(prepare(argv("curl -v")).error, "No URL found");
});

test("formatCommand round-trips", () => {
  const src = `curl -XPOST https://x.dev/a?b=1 -H 'A: it'"'"'s' -d '{"x":1}' --compressed`;
  const multi = formatCommand(argv(src), true);
  assert.equal(
    multi,
    `curl 'https://x.dev/a?b=1' \\\n  -X POST \\\n  -H 'A: it'\\''s' \\\n  -d '{"x":1}' \\\n  --compressed`,
  );
  assert.deepEqual(prepare(argv(multi)).args.sort(), prepare(argv(src)).args.sort());
  assert.deepEqual(argv(formatCommand(argv(multi), false)), argv(multi));
});

test("formatCommand keeps short switches bundled", () => {
  assert.equal(formatCommand(argv("curl -sSL -k https://x.dev -H 'A: 1'"), false), "curl 'https://x.dev' -sSLk -H 'A: 1'");
});
