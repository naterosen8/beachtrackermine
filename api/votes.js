// Vercel serverless function: beachgoers vote on each other's reports.
//   POST /api/votes { beachId, reportId, vote: "up"|"down" } -> { up, down }
// One vote per visitor per report, never on your own. Counts live in votes:<beachId> and expire
// with the reports; api/reports.js adds them to each report, and the page weighs reports by them.
// Votes also move the reporter's points (+2 up, -2 down).

const { awardPoints, store, visitorKey, readBody, REPORT_ID_RE, parseVotes } = require("./_store.js");
const { POINTS } = require("../js/points.js");

const KEEP_SECONDS = 6 * 60 * 60; // as long as reports are kept
const VOTES_PER_HOUR = 60; // per visitor
const ID_RE = /^(osm:(node|way|relation)\/\d{1,15}|demo:[a-z0-9-]{1,40})$/;

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const run = store();
  if (!run) return res.status(503).json({ error: "not-configured" });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ error: "Bad request" });
  }
  const { beachId, reportId, vote } = body || {};
  if (typeof beachId !== "string" || !ID_RE.test(beachId) || typeof reportId !== "string" || !REPORT_ID_RE.test(reportId) || !["up", "down"].includes(vote)) {
    return res.status(400).json({ error: "Bad vote" });
  }

  try {
    const voter = visitorKey(req);
    const limitKey = `rl:votes:${voter}`;
    const [, count, recent, author, reporter] = await run([
      ["SET", limitKey, 0, "NX", "EX", 3600],
      ["INCR", limitKey],
      ["LRANGE", `recent:${beachId}`, 0, 49],
      ["GET", `by:${reportId}`],
      ["GET", `rep:${reportId}`],
    ]);
    if (count > VOTES_PER_HOUR) return res.status(429).json({ error: "That's a lot of votes. Try again later." });
    const exists = (recent || []).some((s) => { try { return JSON.parse(s).id === reportId; } catch { return false; } });
    if (!exists) return res.status(404).json({ error: "That report has expired." });
    if (author === voter) return res.status(403).json({ error: "You can't vote on your own report." });
    const [fresh] = await run([["SET", `voted:${reportId}:${voter}`, "1", "NX", "EX", KEEP_SECONDS]]);
    if (fresh !== "OK") return res.status(409).json({ error: "You already voted on this report." });
    const [, , flat] = await run([
      ["HINCRBY", `votes:${beachId}`, `${reportId}:${vote}`, 1],
      ["EXPIRE", `votes:${beachId}`, KEEP_SECONDS],
      ["HGETALL", `votes:${beachId}`],
      ...(reporter ? awardPoints(reporter, POINTS[vote]) : []), // the reporter gains or loses points
    ]);
    return res.status(200).json(parseVotes(flat)[reportId] || { up: 0, down: 0 });
  } catch (err) {
    console.warn(`votes: ${err.message}`);
    return res.status(502).json({ error: "Vote store unavailable" });
  }
}

module.exports = handler;
