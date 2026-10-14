// Local stand-in for Vercel + Upstash, for testing the api/ functions without deploying: serves the
// repo's static files, runs api/*.js handlers and answers Upstash's REST /pipeline with an in-memory
// Redis (data is lost on restart). Usage: node tools/devserver.js <repo folder> <port>
const http = require("http");
const fs = require("fs");
const path = require("path");
const [repo, port] = [process.argv[2], Number(process.argv[3] || 8790)];

// --- tiny Redis -------------------------------------------------------------
const db = new Map(); // key -> { v, exp }
const live = (k) => { const e = db.get(k); if (e && e.exp && e.exp < Date.now()) { db.delete(k); return null; } return e || null; };
const val = (k, make) => { let e = live(k); if (!e) { e = { v: make() }; db.set(k, e); } return e; };
function cmd([name, ...a]) {
  const n = name.toUpperCase();
  const k = String(a[0]);
  switch (n) {
    case "SET": {
      const opts = a.slice(2).map(String);
      if (opts.includes("NX") && live(k)) return null;
      const ex = opts.indexOf("EX");
      db.set(k, { v: String(a[1]), exp: ex >= 0 ? Date.now() + Number(opts[ex + 1]) * 1000 : 0 });
      return "OK";
    }
    case "GET": { const e = live(k); return e ? e.v : null; }
    case "DEL": return a.reduce((n2, key) => n2 + (db.delete(String(key)) ? 1 : 0), 0);
    case "INCR": { const e = val(k, () => "0"); e.v = String(Number(e.v) + 1); return Number(e.v); }
    case "EXPIRE": { const e = live(k); if (!e) return 0; e.exp = Date.now() + Number(a[1]) * 1000; return 1; }
    case "LPUSH": { const e = val(k, () => []); e.v.unshift(...a.slice(1).map(String)); return e.v.length; }
    case "LTRIM": { const e = live(k); if (e) e.v = e.v.slice(Number(a[1]), Number(a[2]) + 1); return "OK"; }
    case "LRANGE": { const e = live(k); return e ? e.v.slice(Number(a[1]), Number(a[2]) === -1 ? undefined : Number(a[2]) + 1) : []; }
    case "HINCRBY": { const e = val(k, () => ({})); e.v[a[1]] = String(Number(e.v[a[1]] || 0) + Number(a[2])); return Number(e.v[a[1]]); }
    case "HSET": { const e = val(k, () => ({})); for (let i = 1; i < a.length; i += 2) e.v[a[i]] = String(a[i + 1]); return 1; }
    case "HGET": { const e = live(k); return e && e.v[a[1]] != null ? e.v[a[1]] : null; }
    case "HDEL": { const e = live(k); let c = 0; if (e) for (const f of a.slice(1)) if (delete e.v[f]) c++; return c; }
    case "HLEN": { const e = live(k); return e ? Object.keys(e.v).length : 0; }
    case "HGETALL": { const e = live(k); return e ? Object.entries(e.v).flat() : []; }
    case "ZINCRBY": { const e = val(k, () => ({})); e.v[a[2]] = Number(e.v[a[2]] || 0) + Number(a[1]); return String(e.v[a[2]]); }
    case "ZSCORE": { const e = live(k); return e && e.v[a[1]] != null ? String(e.v[a[1]]) : null; }
    case "ZREVRANK": { const e = live(k); if (!e || e.v[a[1]] == null) return null; return Object.entries(e.v).sort((x, y) => y[1] - x[1]).findIndex(([m]) => m === a[1]); }
    case "ZREVRANGE": { const e = live(k); if (!e) return []; const all = Object.entries(e.v).sort((x, y) => y[1] - x[1]).slice(Number(a[1]), Number(a[2]) + 1); return a.map(String).includes("WITHSCORES") ? all.flatMap(([m, s]) => [m, String(s)]) : all.map(([m]) => m); }
    case "ZCARD": { const e = live(k); return e ? Object.keys(e.v).length : 0; }
    default: throw new Error(`fake redis: ${n} not supported`);
  }
}

// --- server -----------------------------------------------------------------
process.env.UPSTASH_REDIS_REST_URL = `http://localhost:${port}/__redis`;
process.env.UPSTASH_REDIS_REST_TOKEN = "dev";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".json": "application/json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  if (url.pathname === "/__redis/pipeline") {
    const out = JSON.parse(raw).map((c) => { try { return { result: cmd(c) }; } catch (e) { return { error: e.message }; } });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  }
  if (url.pathname === "/__redis/dump") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify([...db.keys()])); }
  if (url.pathname.startsWith("/api/")) {
    const file = path.join(repo, "api", `${path.basename(url.pathname)}.js`);
    if (!fs.existsSync(file) || path.basename(file).startsWith("_")) { res.writeHead(404); return res.end("not found"); }
    const handler = require(file);
    let body = raw;
    if ((req.headers["content-type"] || "").includes("json") && raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
    const vres = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.headers["Content-Type"] = "application/json"; res.writeHead(this.statusCode, this.headers); res.end(JSON.stringify(b)); return this; },
      send(b) { res.writeHead(this.statusCode, this.headers); res.end(b); return this; },
    };
    const vreq = { method: req.method, headers: { ...req.headers, "x-forwarded-for": req.headers["x-test-ip"] || "127.0.0.1" }, query: Object.fromEntries(url.searchParams), body };
    try { await handler(vreq, vres); } catch (e) { console.error(e); res.writeHead(500); res.end(String(e)); }
    return;
  }
  const p = path.join(repo, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  if (!p.startsWith(repo) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
}).listen(port, () => console.log(`dev server on ${port}`));
