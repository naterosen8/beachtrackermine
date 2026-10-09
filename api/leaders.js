// Vercel serverless function: the weekly board of top reporters.
//   GET  /api/leaders?me=<reporterId> -> { week, top: [{ name, points, reports, you? }], me?: { name, points, reports, rank, total } }
//   POST /api/leaders { reporter, name } -> { ok: true, name }   (pick a nickname)
// Reporter ids are private to each device: the board shows names only. Without a nickname a reporter
// is "Beachgoer" plus four characters derived from (not part of) their id.

const crypto = require("crypto");
const { store, visitorKey, readBody } = require("./_store.js");
const { REPORTER_RE, BOARD_SIZE, weekKey, cleanName } = require("../js/points.js");

const NAME_CHANGES_PER_DAY = 10; // per visitor

const defaultName = (reporter) => `Beachgoer ${crypto.createHash("sha256").update(`name:${reporter}`).digest("hex").slice(0, 4).toUpperCase()}`;

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const run = store();
  if (!run) return res.status(503).json({ error: "not-configured" });
  try {
    if (req.method === "GET") {
      const week = weekKey();
      const me = String((req.query && req.query.me) || "");
      const flat = await run([["ZREVRANGE", `board:${week}`, 0, BOARD_SIZE - 1, "WITHSCORES"]]).then((r) => r[0] || []);
      const ids = [];
      for (let i = 0; i + 1 < flat.length; i += 2) ids.push({ id: flat[i], points: Number(flat[i + 1]) || 0 });
      const mine = REPORTER_RE.test(me);
      const extra = await run([
        ...ids.flatMap(({ id }) => [["HGET", "names", id], ["ZSCORE", `reports:${week}`, id]]),
        ...(mine ? [["HGET", "names", me], ["ZSCORE", `board:${week}`, me], ["ZREVRANK", `board:${week}`, me], ["ZSCORE", `reports:${week}`, me], ["ZSCORE", "board:all", me]] : []),
      ]);
      const top = ids.map(({ id, points }, i) => {
        const row = { name: extra[2 * i] || defaultName(id), points, reports: Number(extra[2 * i + 1]) || 0 };
        if (mine && id === me) row.you = true;
        return row;
      });
      const body = { week, top };
      if (mine) {
        const [name, points, rank, reports, total] = extra.slice(2 * ids.length);
        body.me = {
          name: name || defaultName(me),
          named: !!name,
          points: Number(points) || 0,
          reports: Number(reports) || 0,
          rank: rank == null ? null : Number(rank) + 1,
          total: Number(total) || 0,
        };
      }
      return res.status(200).json(body);
    }

    if (req.method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return res.status(400).json({ error: "Bad request" });
      }
      if (!body || typeof body.reporter !== "string" || !REPORTER_RE.test(body.reporter)) return res.status(400).json({ error: "Bad request" });
      let name;
      try {
        name = cleanName(body.name);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      const limitKey = `rl:names:${visitorKey(req)}`;
      const [, count] = await run([["SET", limitKey, 0, "NX", "EX", 24 * 3600], ["INCR", limitKey]]);
      if (count > NAME_CHANGES_PER_DAY) return res.status(429).json({ error: "Too many name changes today." });
      await run([["HSET", "names", body.reporter, name]]);
      return res.status(200).json({ ok: true, name });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.warn(`leaders: ${err.message}`);
    return res.status(502).json({ error: "Board unavailable" });
  }
}

module.exports = handler;
module.exports.defaultName = defaultName;
