// Local HTTP server with fixed routes, used by the backend and end-to-end tests.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// 1x1 transparent PNG
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
export const BIG_JSON = '{"id":12345678901234567890,"name":"Ada","tags":["a","b"],"nested":{"ok":true,"none":null}}';

export async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");

    switch (url.pathname) {
      case "/json":
        res.writeHead(200, { "content-type": "application/json", "x-test": "yes" });
        return res.end(BIG_JSON);
      case "/echo":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ method: req.method, query: url.search, headers: req.headers, body }));
      case "/redirect":
        res.writeHead(302, { location: "/json" });
        return res.end();
      case "/status":
        res.writeHead(Number(url.searchParams.get("code") ?? 200), { "content-type": "text/plain" });
        return res.end(`status ${url.searchParams.get("code")}`);
      case "/empty":
        res.writeHead(204);
        return res.end();
      case "/html":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><title>t</title><h1 class=\"x\">Hello Curlman</h1>");
      case "/image":
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      case "/binary":
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]));
      case "/unicode":
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end("héllo € 日本");
      case "/slow": {
        const t = setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("finally");
        }, Number(url.searchParams.get("ms") ?? 5000));
        res.on("close", () => clearTimeout(t));
        return;
      }
      default:
        res.writeHead(404, { "content-type": "application/json" });
        return res.end('{"error":"not found"}');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
