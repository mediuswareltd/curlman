import { test } from "node:test";
import assert from "node:assert/strict";
import { complete, contextAt } from "./suggest.ts";

/** Completes at the `|` marker; returns labels and a function applying item i. */
function at(marked: string) {
  const caret = marked.indexOf("|");
  const src = marked.replace("|", "");
  const c = complete(src, caret);
  return {
    labels: c?.items.map((i) => i.label) ?? [],
    apply: (i = 0) => src.slice(0, c!.from) + c!.items[i].insert + src.slice(c!.to),
    c,
  };
}

test("contextAt tracks tokens, quotes and the current segment", () => {
  const src = `curl x -H 'Content-Ty`;
  const ctx = contextAt(src, src.length);
  assert.deepEqual(ctx.tokens, ["curl", "x", "-H"]);
  assert.equal(ctx.quote, "'");
  assert.equal(src.slice(ctx.segStart), "Content-Ty");
  assert.deepEqual(contextAt("curl a \\\n  -", 13).tokens, ["curl", "a"]);
});

test("completes the curl command itself", () => {
  assert.deepEqual(at("cu|").labels, ["curl"]);
  assert.equal(at("cu|").apply(), "curl ");
  assert.equal(at("curl|").c, null);
  assert.equal(at("https://x|").c, null);
});

test("flags: dash lists everything, prefixes narrow, inserts short or long form", () => {
  assert.ok(at("curl x -|").labels.length > 30);
  assert.equal(at("curl x --he|").labels[0], "-I, --head");
  assert.ok(at("curl x --he|").labels.includes("-H, --header"));
  assert.equal(at("curl x --heade|").apply(), "curl x --header '");
  assert.equal(at("curl x -H|").apply(), "curl x -H '");
  assert.equal(at("curl x --loc|").apply(), "curl x --location ");
  assert.equal(at("curl x --ins|").labels[0], "-k, --insecure");
});

test("flags: an exact switch offers nothing so Enter still sends", () => {
  assert.equal(at("curl x -L|").c, null);
  assert.equal(at("curl x --compressed|").c, null);
  assert.equal(at("curl x -k|").c, null);
});

test("methods after -X", () => {
  assert.deepEqual(at("curl x -X P|").labels, ["POST", "PUT", "PATCH"]);
  assert.equal(at("curl x -X p|").apply(), "curl x -X POST ");
  assert.equal(at("curl x --request |").labels.length, 7);
  assert.equal(at("curl x -X POST|").c, null);
});

test("header names: inside quotes, unquoted, and fuzzy", () => {
  assert.equal(at("curl x -H 'Content-T|").apply(), "curl x -H 'Content-Type: ");
  assert.equal(at("curl x -H 'Content-T|").c!.items[0].reopen, true);
  assert.equal(at("curl x -H auth|").apply(), "curl x -H 'Authorization: ");
  assert.ok(at("curl x -H 'type|").labels.includes("Content-Type"));
  assert.ok(at("curl x -H '|").labels.length > 10);
});

test("header values: close the quote, keep spaces for prefixes, respect existing quote", () => {
  assert.equal(at("curl x -H 'Content-Type: |").apply(), "curl x -H 'Content-Type: application/json'");
  assert.equal(at("curl x -H 'Content-Type: app|").labels[0], "application/json");
  assert.equal(at("curl x -H 'Accept: text/|").apply(), "curl x -H 'Accept: text/html'");
  assert.equal(at("curl x -H 'Authorization: |").apply(), "curl x -H 'Authorization: Bearer ");
  assert.equal(at("curl x -H 'Content-Type: |' -d x").apply(), "curl x -H 'Content-Type: application/json' -d x");
  assert.equal(at("curl x -H 'X-Unknown: |").c, null);
  assert.equal(at("curl x -H 'Content-Type: application/json|").c, null);
});

test("no completions in URLs, bodies or other values", () => {
  assert.equal(at("curl https://api|").c, null);
  assert.equal(at("curl x -d '{\"a|").c, null);
  assert.equal(at("curl x -m 1|").c, null);
});

test("nothing right after a closing quote or inside a concatenated token", () => {
  assert.equal(at("curl x -H 'Accept: application/json'|").c, null);
  assert.equal(at("curl x -H \"A: b\"|").c, null);
  assert.equal(at("curl x -H 'A: '-|").c, null);
  assert.ok(at("curl x -H 'Accept: application/json' -|").c);
});
