export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const span = (cls: string, text: string) => `<span class="${cls}">${esc(text)}</span>`;

/**
 * Highlights the raw editor text. Must preserve every character exactly so the
 * overlay lines up with the textarea underneath.
 */
export function highlightCurl(src: string): string {
  let out = "";
  let i = 0;
  let atStart = true; // at the start of a word
  let firstWord = true;
  let prevFlag = false; // previous word was a flag expecting a value
  const n = src.length;

  const readQuoted = (start: number, quote: string, escapes: boolean) => {
    let j = start + 1;
    while (j < n && src[j] !== quote) j += escapes && src[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, n);
  };

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      out += c;
      i++;
      atStart = true;
      continue;
    }
    const cont = /^(\\|\^)[ \t]*(?=\r?\n|$)/.exec(src.slice(i, i + 64));
    if (cont) {
      out += span("t-cont", cont[0]);
      i += cont[0].length;
      continue;
    }
    if (c === "'" || c === '"' || (c === "$" && src[i + 1] === "'")) {
      const start = c === "$" ? i + 1 : i;
      const end = readQuoted(start, src[start], src[start] === '"' || c === "$");
      const text = src.slice(i, end);
      const cls = /^\$?['"]?[a-z]+:\/\//i.test(text) ? "t-url" : prevFlag ? "t-val" : "t-str";
      out += span(cls, text);
      i = end;
      atStart = false;
      firstWord = false;
      continue;
    }
    // bare word (stop at quotes so `-H'x'` splits nicely)
    let j = i;
    while (j < n && !/[\s'"]/.test(src[j]) && !(src[j] === "^" && src[j + 1] === '"')) j++;
    if (j === i) j = i + 1; // lone ^ in cmd syntax
    const word = src.slice(i, j);
    let cls = "";
    if (atStart && firstWord && /^(\$\s*)?curl(\.exe)?$/i.test(word)) cls = "t-cmd";
    else if (atStart && /^-{1,2}[A-Za-z#:]/.test(word)) cls = "t-flag";
    else if (/^[a-z]+:\/\//i.test(word)) cls = "t-url";
    else if (word === "^") cls = "t-cont";
    out += cls ? span(cls, word) : esc(word);
    if (atStart) prevFlag = cls === "t-flag";
    atStart = false;
    firstWord = false;
    i = j;
  }
  return out;
}

/**
 * Pretty-prints JSON text without round-tripping through JS numbers, so
 * large integer IDs and number formatting stay byte-for-byte intact.
 */
export function prettyJson(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed || !/^[[{"\d\-tfn]/.test(trimmed)) return null;
  try {
    JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parts: string[] = [];
  let ind = 0;
  const nl = () => "\n" + "  ".repeat(ind);
  const n = trimmed.length;
  for (let i = 0; i < n; i++) {
    const c = trimmed[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && trimmed[j] !== '"') j += trimmed[j] === "\\" ? 2 : 1;
      parts.push(trimmed.slice(i, j + 1));
      i = j;
    } else if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      continue;
    } else if (c === "{" || c === "[") {
      let j = i + 1;
      while (j < n && " \n\r\t".includes(trimmed[j])) j++;
      if (trimmed[j] === (c === "{" ? "}" : "]")) {
        parts.push(c + trimmed[j]);
        i = j;
      } else {
        ind++;
        parts.push(c + nl());
      }
    } else if (c === "}" || c === "]") {
      ind--;
      parts.push(nl() + c);
    } else if (c === ",") {
      parts.push("," + nl());
    } else if (c === ":") {
      parts.push(": ");
    } else {
      parts.push(c);
    }
  }
  return parts.join("");
}

const JSON_RE = /("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],]/g;

export function highlightJson(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(JSON_RE)) {
    const idx = m.index!;
    out += esc(s.slice(last, idx));
    const t = m[0];
    if (m[1]) {
      out += m[2] ? span("j-key", m[1]) + m[2] : span("j-str", t);
    } else if (t === "true" || t === "false") out += `<span class="j-bool">${t}</span>`;
    else if (t === "null") out += `<span class="j-null">null</span>`;
    else if (t.length === 1 && "{}[],".includes(t)) out += `<span class="j-p">${t}</span>`;
    else out += `<span class="j-num">${t}</span>`;
    last = idx + t.length;
  }
  return out + esc(s.slice(last));
}

/** Light-touch highlighting for HTML / XML source. */
export function highlightMarkup(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(/<!--[\s\S]*?-->|<\/?[\w:-]+|\/?>|[\w:-]+(?==)|"[^"]*"|'[^']*'/g)) {
    const idx = m.index!;
    // only treat attribute-ish matches as such inside tags; good enough visually
    out += esc(s.slice(last, idx));
    const t = m[0];
    const cls = t.startsWith("<!--")
      ? "j-null"
      : t.startsWith("<") || t.endsWith(">")
        ? "j-key"
        : t.startsWith('"') || t.startsWith("'")
          ? "j-str"
          : "j-num";
    out += span(cls, t);
    last = idx + t.length;
  }
  return out + esc(s.slice(last));
}
