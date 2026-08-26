#!/usr/bin/env node
// Cost Explorer local: sirve index.html y proxya /np/* a api.nullplatform.com.
//
// La API de NP solo permite CORS desde app.nullplatform.io, asi que el browser
// no puede pegarle directo: este proxy (mismo origen) reenvia los GET agregando
// el header Authorization que manda el front (el token se pega en la UI).
//
// Uso:  node serve.js [puerto]   (default 8787)  ->  http://localhost:8787
// Solo GET, solo /catalog/* — herramienta de exploracion read-only.
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const API = "api.nullplatform.com";
const PORT = Number(process.argv[2]) || 8787;
const HERE = dirname(fileURLToPath(import.meta.url));

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (req.url.startsWith("/np/")) {
    const target = req.url.slice(3); // "/np/catalog/..." -> "/catalog/..."
    if (!target.startsWith("/catalog/")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "solo /catalog/*" }));
      return;
    }
    const preq = https.request(
      { host: API, path: target, method: "GET",
        headers: { Authorization: req.headers.authorization || "", Accept: "application/json" } },
      (pres) => {
        res.writeHead(pres.statusCode, { "Content-Type": pres.headers["content-type"] || "application/json" });
        pres.pipe(res);
      },
    );
    preq.on("error", (e) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    });
    preq.end();
    return;
  }
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = normalize(join(HERE, path));
  if (!file.startsWith(HERE)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Cost Explorer -> http://localhost:${PORT}`));
