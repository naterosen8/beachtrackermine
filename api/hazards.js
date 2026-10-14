// Vercel serverless function: safety alerts for your starred beaches.
//   POST   /api/hazards { subscription, beaches: [{ id, name, lat, lon, zone?, waterSites? }], quiet? } -> { ok: true }
//   DELETE /api/hazards { endpoint } -> { ok: true }
//   GET    /api/hazards   (the scheduled check; needs Authorization: Bearer $CRON_SECRET)
// The check runs every 15 minutes from GitHub Actions (.github/workflows/hazard-check.yml). It pushes
// each National Weather Service beach alert (rip currents, high surf, coastal flooding, tsunami...) for
// a beach's NWS zone, and each county beach closure, once per subscriber.

const crypto = require("crypto");
const { store, clientIp, readBody, pushKeys } = require("./_store.js");
const { parseSubscription } = require("../js/alerts.js");
const { parseBeaches } = require("./_summary.js");
const { parseNwsAlerts, alertsForZone, hazardKey } = require("../js/hazards.js");
const { parseWaterStations, waterFor } = require("../js/water.js");

const KEY = "hazards";
const MAX_SUBSCRIBERS = 2000;
const SIGNUPS_PER_HOUR = 20;
const SENT_SECONDS = 4 * 24 * 60 * 60; // remember what was pushed for 4 days
const PUSHES_PER_RUN = 3; // per subscriber, so a storm doesn't send a flood of notifications
const WATER_LAYER = "https://services.arcgis.com/KkJhFbLnXVqahKz2/arcgis/rest/services/Ocean_Water_Quality_Points_Public/FeatureServer/0/query?where=1%3D1&outFields=Identifier,Beach_Name,Beach_status,StatusDate,Notes&returnGeometry=true&outSR=4326&f=json";
const SB_COUNTY_BOX = { south: 34.3, north: 35.15, west: -120.7, east: -119.4 };

const fieldFor = (endpoint) => crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);
const beachLink = (b) => `/?${new URLSearchParams({ at: `${b.lat.toFixed(4)},${b.lon.toFixed(4)}`, near: b.name, beach: b.id })}`;

async function fetchJson(url) {
  // NWS asks callers to identify themselves.
  const res = await fetch(url, { headers: { "User-Agent": "BeachCheck (beach safety alerts)", Accept: "application/geo+json, application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

// What to push now: [{ entry, beach, key, title, body }], from the current NWS alerts and county closures.
function dueAlerts(entries, alerts, stations) {
  const out = [];
  for (const entry of entries) {
    for (const beach of entry.beaches) {
      for (const a of beach.zone ? alertsForZone(alerts, beach.zone) : []) {
        const until = a.ends ? ` until ${new Date(a.ends).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
        out.push({ entry, beach, key: hazardKey(a), title: `${a.event}: ${beach.name}`, body: `${a.what || a.headline}${until}. From the National Weather Service.` });
      }
      for (const site of waterFor(beach, stations)) {
        if (site.status !== "closed") continue;
        out.push({ entry, beach, key: `closed|${site.id}|${site.date}`, title: `Closed to swimming: ${beach.name}`, body: `Santa Barbara County has closed the water at ${site.name}. Check the county's ocean water page before you go in.` });
      }
    }
  }
  return out;
}

async function runCheck(run, keys) {
  const [flat] = await run([["HGETALL", KEY]]);
  const entries = [];
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    try { entries.push({ field: flat[i], ...JSON.parse(flat[i + 1]) }); } catch { /* skip */ }
  }
  if (!entries.length) return { subscribers: 0, sent: 0, removed: 0 };
  const zones = [...new Set(entries.flatMap((e) => e.beaches.map((b) => b.zone).filter(Boolean)))];
  let alerts = [];
  for (let i = 0; i < zones.length; i += 20) {
    alerts = alerts.concat(parseNwsAlerts(await module.exports.fetchJson(`https://api.weather.gov/alerts/active?status=actual&zone=${zones.slice(i, i + 20).join(",")}`)));
  }
  const inCounty = entries.some((e) => e.beaches.some((b) => b.lat >= SB_COUNTY_BOX.south && b.lat <= SB_COUNTY_BOX.north && b.lon >= SB_COUNTY_BOX.west && b.lon <= SB_COUNTY_BOX.east));
  const stations = inCounty ? parseWaterStations(await module.exports.fetchJson(WATER_LAYER).catch(() => ({}))) : [];

  const due = dueAlerts(entries, alerts, stations);
  let sent = 0;
  const gone = new Set();
  const perEntry = new Map();
  for (const d of due) {
    if (gone.has(d.entry.field) || (perEntry.get(d.entry.field) || 0) >= PUSHES_PER_RUN) continue;
    const [fresh] = await run([["SET", `hz:${d.entry.field}:${d.beach.id}:${d.key}`, "1", "NX", "EX", SENT_SECONDS]]);
    if (fresh !== "OK") continue; // already told them about this one
    const status = await module.exports.sendPush(d.entry.sub, { title: d.title, body: d.body, url: beachLink(d.beach), tag: `hazard-${d.beach.id}` }, keys);
    if (status === 404 || status === 410) gone.add(d.entry.field);
    else { sent++; perEntry.set(d.entry.field, (perEntry.get(d.entry.field) || 0) + 1); }
  }
  if (gone.size) await run([["HDEL", KEY, ...gone]]);
  return { subscribers: entries.length, alerts: alerts.length, sent, removed: gone.size };
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const run = store();
  const keys = pushKeys(req);
  if (!run || !keys) return res.status(503).json({ error: "not-configured" });
  try {
    if (req.method === "GET") {
      const secret = process.env.CRON_SECRET;
      if (!secret || (req.headers && req.headers.authorization) !== `Bearer ${secret}`) return res.status(401).json({ error: "Unauthorized" });
      return res.status(200).json(await runCheck(run, keys));
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
        entry = { sub: parseSubscription(body && body.subscription), beaches: parseBeaches(body && body.beaches) };
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const limitKey = `rl:hazards:${clientIp(req)}`;
      const [, count, size] = await run([["SET", limitKey, 0, "NX", "EX", 3600], ["INCR", limitKey], ["HLEN", KEY]]);
      if (count > SIGNUPS_PER_HOUR) return res.status(429).json({ error: "Too many changes. Try again later." });
      if (size >= MAX_SUBSCRIBERS) return res.status(503).json({ error: "Safety alerts are full right now." });
      await run([["HSET", KEY, fieldFor(entry.sub.endpoint), JSON.stringify(entry)]]);
      if (!body.quiet) {
        const n = entry.beaches.length;
        await module.exports.sendPush(entry.sub, { title: "Safety alerts are on 🚨", body: `You'll be notified about National Weather Service beach warnings and county closures for your ${n} starred beach${n === 1 ? "" : "es"}.`, url: "/", tag: "hazards-on" }, keys);
      }
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      if (!body || typeof body.endpoint !== "string") return res.status(400).json({ error: "Bad request" });
      await run([["HDEL", KEY, fieldFor(body.endpoint)]]);
      return res.status(200).json({ ok: true });
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.warn(`hazards: ${err.message}`);
    return res.status(502).json({ error: "Safety alerts unavailable" });
  }
}

module.exports = handler;
module.exports.sendPush = require("./_store.js").sendPush;
module.exports.fetchJson = fetchJson;
module.exports.dueAlerts = dueAlerts;
