import { test } from "node:test";
import assert from "node:assert/strict";
import { prettyJson, highlightJson, highlightCurl, esc } from "./highlight.ts";

test("prettyJson keeps numbers and strings byte-for-byte", () => {
  assert.equal(
    prettyJson('{"id":12345678901234567890,"f":1.50,"s":"a,b:{c}","e":[],"o":{}}'),
    '{\n  "id": 12345678901234567890,\n  "f": 1.50,\n  "s": "a,b:{c}",\n  "e": [],\n  "o": {}\n}',
  );
  assert.equal(prettyJson('[1, [2, {"a" : "x\\"y"}]]'), '[\n  1,\n  [\n    2,\n    {\n      "a": "x\\"y"\n    }\n  ]\n]');
  assert.equal(prettyJson('"just a string"'), '"just a string"');
});

test("prettyJson rejects non-JSON", () => {
  for (const s of ["", "hello", "{bad}", "<html>", "[1,]"]) assert.equal(prettyJson(s), null, s);
});

test("highlightJson escapes HTML and classifies tokens", () => {
  const html = highlightJson('{"k<": "<b>", "n": -1.5e3, "t": true, "z": null}');
  assert.ok(html.includes('<span class="j-key">&quot;k&lt;&quot;</span>'));
  assert.ok(html.includes('<span class="j-str">&quot;&lt;b&gt;&quot;</span>'));
  assert.ok(html.includes('<span class="j-num">-1.5e3</span>'));
  assert.ok(html.includes('<span class="j-bool">true</span>'));
  assert.ok(html.includes('<span class="j-null">null</span>'));
  assert.ok(!html.includes("<b>"));
});

test("highlightCurl preserves the exact source text", () => {
  const src = `curl 'https://x.dev/a?b=<1>' \\n  -H "A: \\"q\\"" \\n  --data-raw $'x\ny' -sSL ^"z^" # c & d`;
  const plain = highlightCurl(src).replace(/<[^>]+>/g, "");
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  assert.equal(decode(plain), src);
  assert.equal(esc(`<a href="x">&`), "&lt;a href=&quot;x&quot;&gt;&amp;");
});
