// Vercel serverless function: the morning summary of your starred beaches, pushed once a day.
//   POST   /api/morning { subscription, beaches: [{ id, name, lat, lon, waterSites? }], tz, link?, quiet? }
//          -> { ok: true, preview }   (signs up or updates; sends a first summary right away unless quiet)
//   DELETE /api/morning { endpoint } -> { ok: true }
//   GET    /api/morning   (Vercel Cron, daily; needs Authorization: Bearer $CRON_SECRET)
// The cron runs at 15:00 UTC (vercel.json): 8 AM in Pacific summer time, 7 AM in winter. People
// whose local time then isn't morning (6–11 AM) are skipped, since there's one run a day.

const crypto = require("crypto");
const { store, clientIp, readBody, pushKeys } = require("./_store.js");
const { parseSubscription, sitePath } = require("../js/alerts.js");
const { parseBeaches, cleanTimeZone, summaryMessage, loadConditions, fetchJsonNode, inTimeZone } = require("./_summary.js");

const KEY = "morning";
const MAX_SUBSCRIBERS = 2000;
const SIGNUPS_PER_HOUR = 20;

const fieldFor = (endpoint) => crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);

// The summary for one subscriber, in their time zone, for "today" there.
async function buildSummary(entry, fetchJson) {
  const conditions = await loadConditions(entry.beaches, fetchJson);
  const histories = entry.histories || {};
  return inTimeZone(entry.tz, () => summaryMessage(entry.beaches, (b) => ({ ...conditions(b), history: histories[b.id] }), Date.now()));
}

async function withHistories(run, entry) {
  const flats = await run(entry.beaches.map((b) => ["HGETALL", `hist:${b.id}`]));
  const { parseHistory } = require("./reports.js");
  return { ...entry, histories: Object.fromEntries(entry.beaches.map((b, i) => [b.id, parseHistory(flats[i])])) };
}

const localHour = (tz, now = Date.now()) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const run = store();
  const keys = pushKeys(req);
  if (!run || !keys) return res.status(503).json({ error: "not-configured" });
  const send = module.exports.sendPush;
  const fetchJson = module.exports.fetchJson;

  try {
    if (req.method === "GET") {
      // Only Vercel Cron (or someone holding the secret) can send everyone's summaries.
      const secret = process.env.CRON_SECRET;
      if (!secret || (req.headers && req.headers.authorization) !== `Bearer ${secret}`) return res.status(401).json({ error: "Unauthorized" });
      const [flat] = await run([["HGETALL", KEY]]);
      const entries = [];
      for (let i = 0; i + 1 < (flat || []).length; i += 2) {
        try { entries.push({ field: flat[i], ...JSON.parse(flat[i + 1]) }); } catch { /* skip */ }
      }
      let sent = 0;
      let skipped = 0;
      const gone = [];
      for (const entry of entries) {
        const hour = localHour(entry.tz);
        if (hour < 6 || hour >= 11) { skipped++; continue; }
        try {
          const summary = await buildSummary(await withHistories(run, entry), fetchJson);
          const status = await send(entry.sub, { ...summary, url: entry.link, tag: "morning" }, keys);
          if (status === 404 || status === 410) gone.push(entry.field);
          else sent++;
        } catch (err) {
          console.warn(`morning: ${err.message}`);
        }
      }
      if (gone.length) await run([["HDEL", KEY, ...gone]]);
      return res.status(200).json({ sent, skipped, removed: gone.length });
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return res.status(400).json({ error: "Bad request" });
    }

    if (req.method === "POST") {
      let entry;
      try {
        entry = {
          sub: parseSubscription(body && body.subscription),
          beaches: parseBeaches(body && body.beaches),
          tz: cleanTimeZone(body && body.tz),
          link: sitePath(body && body.link),
        };
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const limitKey = `rl:morning:${clientIp(req)}`;
      const [, count, size] = await run([["SET", limitKey, 0, "NX", "EX", 3600], ["INCR", limitKey], ["HLEN", KEY]]);
      if (count > SIGNUPS_PER_HOUR) return res.status(429).json({ error: "Too many changes. Try again later." });
      if (size >= MAX_SUBSCRIBERS) return res.status(503).json({ error: "Morning summaries are full right now." });
      await run([["HSET", KEY, fieldFor(entry.sub.endpoint), JSON.stringify(entry)]]);
      if (body.quiet) return res.status(200).json({ ok: true }); // just an update to the starred beaches
      // Send today's summary now, so people see what they signed up for (and that it works).
      const summary = await buildSummary(await withHistories(run, entry), fetchJson);
      const status = await send(entry.sub, { title: "Morning summary is on ☀️", body: `${summary.body}\n(Next one tomorrow around 8 AM)`, url: entry.link, tag: "morning" }, keys);
      return res.status(200).json({ ok: true, preview: summary, delivered: status >= 200 && status < 300 });
    }

    if (req.method === "DELETE") {
      if (!body || typeof body.endpoint !== "string") return res.status(400).json({ error: "Bad request" });
      await run([["HDEL", KEY, fieldFor(body.endpoint)]]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.warn(`morning: ${err.message}`);
    return res.status(502).json({ error: "Morning summary unavailable" });
  }
}

module.exports = handler;
module.exports.sendPush = require("./_store.js").sendPush;
module.exports.fetchJson = fetchJsonNode;
module.exports.localHour = localHour;
