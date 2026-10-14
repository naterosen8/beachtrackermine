// Street sweeping: the City of Santa Barbara's official block-by-block schedule (the data behind
// santabarbaraca.gov/StreetSweeping), turned into "next sweeping" dates. Only schedules whose wording
// says exactly when are turned into dates; anything else is shown as the city wrote it.
// Pure functions, no DOM, so they can be tested in Node.

const SWEEP_DAYS = { sundays: 0, mondays: 1, tuesdays: 2, wednesdays: 3, thursdays: 4, fridays: 5, saturdays: 6 };
const SWEEP_NEAR_M = 30; // a route this close to where you parked is your street

// "8am", "6:30am", "12pm" -> { h, m } (24-hour), or null.
function clockTime(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(String(text).trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  return { h, m: Number(m[2] || 0) };
}

// The city's schedule text -> one of:
//   { notSwept: true }
//   { days: [1, 3, 5], nth: null | [1, 3], start: { h, m } | null, end: { h, m } | null }
//   { unknown: true } when the wording doesn't say exactly when (e.g. "Wednesdays 2x A Month").
function parseSweepSchedule(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (/^not swept$/i.test(t)) return { notSwept: true };
  const m = /^(?:(1st|2nd|3rd|4th) & (1st|2nd|3rd|4th) )?([A-Za-z]+(?:\/[A-Za-z]+)*)(?: (\S+) [–-] (\S+))?$/.exec(t);
  if (!m) return { unknown: true };
  const days = m[3].toLowerCase().split("/").map((d) => SWEEP_DAYS[d]);
  if (days.some((d) => d === undefined)) return { unknown: true };
  const nth = m[1] ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
  const start = m[4] ? clockTime(m[4]) : null;
  const end = m[5] ? clockTime(m[5]) : null;
  if (m[4] && (!start || !end)) return { unknown: true };
  return { days, nth, start, end };
}

// The next sweeping on or after `from` (local time): { start: Date, end: Date | null, timed: bool },
// or null when the schedule doesn't say exactly when. A sweeping already under way counts.
function nextSweeping(schedule, from = new Date()) {
  if (!schedule || schedule.unknown || schedule.notSwept) return null;
  for (let i = 0; i < 70; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (!schedule.days.includes(day.getDay())) continue;
    if (schedule.nth && !schedule.nth.includes(Math.ceil(day.getDate() / 7))) continue;
    if (!schedule.start) {
      if (i === 0 && from.getHours() >= 23) continue;
      return { start: day, end: null, timed: false };
    }
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), schedule.start.h, schedule.start.m);
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), schedule.end.h, schedule.end.m);
    if (end > from) return { start, end, timed: true };
  }
  return null;
}

// Metres from a point to a polyline [[lon, lat], ...] (flat-earth approximation; fine at street scale).
function metresToLine(point, path) {
  const kx = 111320 * Math.cos((point.lat * Math.PI) / 180);
  const ky = 110540;
  const px = point.lon * kx;
  const py = point.lat * ky;
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = [path[i][0] * kx, path[i][1] * ky];
    const [bx, by] = [path[i + 1][0] * kx, path[i + 1][1] * ky];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

// The sweeping routes for where you are: the nearest route within SWEEP_NEAR_M, plus any other
// schedule within 10 m of it (the two sides of a street can differ). [{ schedule, type, metres }].
function sweepRoutesNear(point, features) {
  const routes = (features || []).flatMap((f) => {
    const paths = (f.geometry && f.geometry.paths) || [];
    if (!paths.length) return [];
    const metres = Math.min(...paths.map((p) => metresToLine(point, p)));
    return [{ schedule: String(f.attributes.Schedule || "").trim(), type: f.attributes.Route_Type, metres }];
  }).filter((r) => r.metres <= SWEEP_NEAR_M).sort((a, b) => a.metres - b.metres);
  if (!routes.length) return [];
  const seen = new Set();
  return routes.filter((r) => r.metres <= routes[0].metres + 10).filter((r) => {
    const key = `${r.type}|${r.schedule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

if (typeof module !== "undefined") {
  module.exports = { SWEEP_NEAR_M, clockTime, parseSweepSchedule, nextSweeping, metresToLine, sweepRoutesNear };
}
