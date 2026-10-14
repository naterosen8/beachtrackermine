// Official tides: NOAA high/low predictions from the nearest NOAA station, in feet above mean lower
// low water (the zero tide tables use). Pure functions, no DOM, so they can be tested in Node.

const TIDE_STATION_MAX_KM = 40; // farther than this, the station doesn't speak for the beach
const TIDE_LIST = typeof TIDE_STATIONS !== "undefined" ? TIDE_STATIONS : require("./tide-stations.js").TIDE_STATIONS;
const TIDE_DIST = typeof distanceKm === "function" ? distanceKm : require("./crowd.js").distanceKm;

// The nearest NOAA station within TIDE_STATION_MAX_KM: { id, name, km }, or null.
function nearestTideStation(point, stations = TIDE_LIST) {
  let best = null;
  for (const [id, name, lat, lon] of stations) {
    const km = TIDE_DIST(point, { lat, lon });
    if (km <= TIDE_STATION_MAX_KM && (!best || km < best.km)) best = { id, name, km };
  }
  return best;
}

// NOAA "hilo" predictions (time_zone=gmt) -> [{ type: "high"|"low", time: ms, ft }] in time order.
function parseNoaaTides(json) {
  return ((json && json.predictions) || [])
    .map((p) => ({
      type: p.type === "H" ? "high" : p.type === "L" ? "low" : null,
      time: Date.parse(`${String(p.t).replace(" ", "T")}:00Z`),
      ft: Number(p.v),
    }))
    .filter((t, i) => t.type && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(json.predictions[i].t) && Number.isFinite(t.time) && Number.isFinite(t.ft))
    .sort((a, b) => a.time - b.time);
}

// The tide around `time`: rising or falling, the next turn and the one after: { rising, next, after }.
function tideFromTurns(turns, time) {
  const i = (turns || []).findIndex((t) => t.time > time);
  if (i < 0) return null;
  return { rising: turns[i].type === "high", next: turns[i], after: turns[i + 1] || null };
}

// Highs and lows falling on the local calendar day of `day`.
function turnsOnDay(turns, day) {
  const d = new Date(day).toDateString();
  return (turns || []).filter((t) => new Date(t.time).toDateString() === d);
}

if (typeof module !== "undefined") {
  module.exports = { TIDE_STATION_MAX_KM, nearestTideStation, parseNoaaTides, tideFromTurns, turnsOnDay };
}
