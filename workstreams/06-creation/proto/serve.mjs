#!/usr/bin/env node
/**
 * A static file server for the prototype, on the loopback interface only.
 *
 *   node workstreams/06-creation/proto/serve.mjs [port]
 *   open http://127.0.0.1:8606/proto/
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const port = Number(process.argv[2] ?? 8606);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!path.startsWith(ROOT + sep) && path !== ROOT) { res.writeHead(403).end(); return; }
  if (url.pathname.endsWith("/")) path = join(path, "index.html");
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`prototype: http://127.0.0.1:${port}/proto/`));
