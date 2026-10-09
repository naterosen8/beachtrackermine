// Vercel serverless function: sign up for "my beach is busy" push alerts.
//   GET    /api/alerts -> { publicKey } (503 until the store and push keys are set up)
//   POST   /api/alerts { beachId, name, level: 4|5, parking?, link?, subscription } -> { ok: true }
//   DELETE /api/alerts { beachId, endpoint } -> { ok: true }
// Sign-ups live in a hash per beach (alerts:<beachId>), keyed by a hash of the push endpoint, and
// api/reports.js sends the pushes when a report comes in.

const crypto = require("crypto");
const { store, clientIp, readBody, pushKeys } = require("./_store.js");
const { parseAlertSignup } = require("../js/alerts.js");

const KEEP_SECONDS = 180 * 24 * 60 * 60; // sign-ups for a beach nobody touches fade after 6 months
const MAX_PER_BEACH = 5000;
const SIGNUPS_PER_HOUR = 30; // per visitor
const ID_RE = /^(osm:(node|way|relation)\/\d{1,15}|demo:[a-z0-9-]{1,40})$/;

const fieldFor = (endpoint) => crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const run = store();
  const keys = pushKeys(req);
  if (!run || !keys) return res.status(503).json({ error: "not-configured" });

  try {
    if (req.method === "GET") return res.status(200).json({ publicKey: keys.publicKey });

    let body;
    try {
      body = await readBody(req);
    } catch {
      return res.status(400).json({ error: "Bad request" });
    }

    if (req.method === "POST") {
      let parsed;
      try {
        parsed = parseAlertSignup(body);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const limitKey = `rl:alerts:${clientIp(req)}`;
      const [, count] = await run([["SET", limitKey, 0, "NX", "EX", 3600], ["INCR", limitKey]]);
      if (count > SIGNUPS_PER_HOUR) return res.status(429).json({ error: "Too many alert changes. Try again later." });
      const key = `alerts:${parsed.beachId}`;
      const [size] = await run([["HLEN", key]]);
      if (size >= MAX_PER_BEACH) return res.status(503).json({ error: "Alerts for this beach are full right now." });
      await run([
        ["HSET", key, fieldFor(parsed.alert.sub.endpoint), JSON.stringify(parsed.alert)],
        ["EXPIRE", key, KEEP_SECONDS],
      ]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const beachId = body && body.beachId;
      if (typeof beachId !== "string" || !ID_RE.test(beachId) || typeof body.endpoint !== "string") {
        return res.status(400).json({ error: "Bad request" });
      }
      await run([["HDEL", `alerts:${beachId}`, fieldFor(body.endpoint)]]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.warn(`alerts: ${err.message}`);
    return res.status(502).json({ error: "Alert store unavailable" });
  }
}

module.exports = handler;
module.exports.fieldFor = fieldFor;
