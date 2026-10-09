// Vercel serverless function: the photo sent with a report.
//   GET /api/photo?beach=<beachId>&id=<reportId> -> image/jpeg
// Photos expire with their report (6 hours). A report beachgoers flagged as wrong stops serving its
// photo, so a bad photo comes down as soon as enough people vote it down.

const { store, REPORT_ID_RE, parseVotes } = require("./_store.js");
const { isFlagged } = require("../js/crowd.js");

const ID_RE = /^(osm:(node|way|relation)\/\d{1,15}|demo:[a-z0-9-]{1,40})$/;

async function handler(req, res) {
  const run = store();
  if (!run) return res.status(503).json({ error: "not-configured" });
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const beachId = String((req.query && req.query.beach) || "");
  const id = String((req.query && req.query.id) || "");
  if (!ID_RE.test(beachId) || !REPORT_ID_RE.test(id)) return res.status(400).json({ error: "Bad request" });
  try {
    const [photo, flat] = await run([["GET", `photo:${id}`], ["HGETALL", `votes:${beachId}`]]);
    if (!photo) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).json({ error: "This photo has expired." });
    }
    if (isFlagged(parseVotes(flat)[id] || {})) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(410).json({ error: "Beachgoers flagged this report." });
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=300"); // short, so flagging takes effect soon
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(Buffer.from(photo, "base64"));
  } catch (err) {
    console.warn(`photo: ${err.message}`);
    return res.status(502).json({ error: "Photo store unavailable" });
  }
}

module.exports = handler;
