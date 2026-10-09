// Vercel serverless function for beachgoer reports, stored in Upstash Redis (or Vercel KV).
//   GET  /api/reports?ids=osm:way/1,osm:node/2  -> { reports: { id: [report] }, history: { id: { slot: { sum, count } } } }
//   POST /api/reports { beachId, crowd: 1..5, parking?, note?, slot: "we:14" } -> { ok: true, report }
// Each report has an id that beachgoers vote on (api/votes.js); GET adds its { up, down } counts.
// Recent reports expire after a few hours; per-slot totals are kept so we can learn each beach's patterns.
// After each report, anyone watching that beach (api/alerts.js) gets a push if it's now busy.
// Without a store configured it answers 503, and the site falls back to saving reports on the device.

const { store, clientIp, visitorKey, readBody, pushKeys, sendPush, newReportId, parseVotes } = require("./_store.js");
const { liveStatus } = require("../js/crowd.js");
const { alertReason, alertMessage, ALERT_COOLDOWN_MS } = require("../js/alerts.js");

const KEEP_SECONDS = 6 * 60 * 60;
const MAX_PUSHES = 300; // alerts sent per report, at most
const MAX_RECENT = 50;
const MAX_IDS = 60;
const RATE_LIMIT_SECONDS = 10 * 60; // one report per beach per visitor every 10 minutes
const PARKING = ["plenty", "some", "full"];
const ID_RE = /^(osm:(node|way|relation)\/\d{1,15}|demo:[a-z0-9-]{1,40})$/;
const SLOT_RE = /^(we|wd):([01]?\d|2[0-3])$/;

// Checks a submitted report; returns the cleaned report or throws with a message for the user.
function parseReport(body, now = Date.now(), id = newReportId()) {
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.beachId !== "string" || !ID_RE.test(b.beachId)) throw new Error("Unknown beach");
  const crowd = Number(b.crowd);
  if (!Number.isInteger(crowd) || crowd < 1 || crowd > 5) throw new Error("Crowd must be 1 to 5");
  if (b.parking != null && !PARKING.includes(b.parking)) throw new Error("Unknown parking value");
  if (typeof b.slot !== "string" || !SLOT_RE.test(b.slot)) throw new Error("Missing time slot");
  const note = typeof b.note === "string" ? b.note.replace(/\s+/g, " ").trim().slice(0, 140) : "";
  const report = { id, time: now, crowd };
  if (b.parking) report.parking = b.parking;
  if (note) report.note = note;
  return { beachId: b.beachId, slot: b.slot, report };
}

// Turns HGETALL's flat [field, value, ...] list of "we:14:sum"/"we:14:n" into { "we:14": { sum, count } }.
function parseHistory(flat) {
  const history = {};
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    const m = /^(.+):(sum|n)$/.exec(flat[i]);
    if (!m) continue;
    const slot = (history[m[1]] = history[m[1]] || { sum: 0, count: 0 });
    slot[m[2] === "sum" ? "sum" : "count"] = Number(flat[i + 1]) || 0;
  }
  return history;
}

// Pushes an alert to everyone watching this beach whose settings the live status now meets,
// at most once per person every few hours. Never fails the report it follows.
async function notifyWatchers(run, beachId, keys) {
  const [recentRaw, watchersRaw] = await run([
    ["LRANGE", `recent:${beachId}`, 0, MAX_RECENT - 1],
    ["HGETALL", `alerts:${beachId}`],
  ]);
  const watchers = Array.isArray(watchersRaw) ? watchersRaw : [];
  if (!watchers.length) return 0;
  const reports = (Array.isArray(recentRaw) ? recentRaw : [])
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);
  const live = liveStatus(reports);
  if (!live) return 0;

  const due = [];
  for (let i = 0; i + 1 < watchers.length && due.length < MAX_PUSHES; i += 2) {
    let alert;
    try { alert = JSON.parse(watchers[i + 1]); } catch { continue; }
    const reason = alertReason(live, alert);
    if (reason) due.push({ field: watchers[i], alert, reason });
  }
  if (!due.length) return 0;
  // Claim each cooldown first, so two reports at once don't both alert the same person.
  const claims = await run(due.map((d) => ["SET", `alerted:${beachId}:${d.field}`, "1", "NX", "EX", ALERT_COOLDOWN_MS / 1000]));
  const sends = due.filter((_, i) => claims[i] === "OK");
  const statuses = await Promise.all(sends.map(({ alert, reason }) =>
    module.exports.sendPush(alert.sub, { ...alertMessage(alert.name, live, reason), url: alert.link, tag: `busy-${beachId}` }, keys)));
  const gone = sends.filter((_, i) => statuses[i] === 404 || statuses[i] === 410).map((d) => d.field);
  if (gone.length) await run([["HDEL", `alerts:${beachId}`, ...gone]]);
  return sends.length;
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const run = store();
  if (!run) return res.status(503).json({ error: "not-configured" });

  try {
    if (req.method === "GET") {
      const ids = String((req.query && req.query.ids) || "").split(",").filter((id) => ID_RE.test(id)).slice(0, MAX_IDS);
      if (!ids.length) return res.status(200).json({ reports: {}, history: {} });
      const results = await run(ids.flatMap((id) => [
        ["LRANGE", `recent:${id}`, 0, MAX_RECENT - 1],
        ["HGETALL", `hist:${id}`],
        ["HGETALL", `votes:${id}`],
      ]));
      const cutoff = Date.now() - KEEP_SECONDS * 1000;
      const reports = {};
      const history = {};
      ids.forEach((id, i) => {
        const votes = parseVotes(results[3 * i + 2]);
        reports[id] = (results[3 * i] || []).map((s) => { try { return JSON.parse(s); } catch { return null; } })
          .filter((r) => r && r.time >= cutoff)
          .map((r) => (r.id && votes[r.id] ? { ...r, ...votes[r.id] } : r));
        history[id] = parseHistory(results[3 * i + 1]);
      });
      return res.status(200).json({ reports, history });
    }

    if (req.method === "POST") {
      let parsed;
      try {
        parsed = parseReport(await readBody(req));
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const { beachId, slot, report } = parsed;
      const [fresh] = await run([["SET", `rl:${clientIp(req)}:${beachId}`, "1", "NX", "EX", RATE_LIMIT_SECONDS]]);
      if (fresh !== "OK") return res.status(429).json({ error: "You reported this beach a few minutes ago. Thanks!" });
      await run([
        ["LPUSH", `recent:${beachId}`, JSON.stringify(report)],
        ["LTRIM", `recent:${beachId}`, 0, MAX_RECENT - 1],
        ["EXPIRE", `recent:${beachId}`, KEEP_SECONDS],
        ["HINCRBY", `hist:${beachId}`, `${slot}:sum`, report.crowd],
        ["HINCRBY", `hist:${beachId}`, `${slot}:n`, 1],
        ["SET", `by:${report.id}`, visitorKey(req), "EX", KEEP_SECONDS], // so nobody votes on their own report
      ]);
      const keys = pushKeys(req);
      if (keys) {
        try {
          await notifyWatchers(run, beachId, keys);
        } catch (err) {
          console.warn(`alerts: ${err.message}`);
        }
      }
      return res.status(200).json({ ok: true, report });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.warn(`reports: ${err.message}`);
    return res.status(502).json({ error: "Report store unavailable" });
  }
}

module.exports = handler;
module.exports.parseReport = parseReport;
module.exports.parseHistory = parseHistory;
module.exports.notifyWatchers = notifyWatchers;
module.exports.sendPush = sendPush;
