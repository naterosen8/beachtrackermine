// Ocean water quality: Santa Barbara County Environmental Health's weekly bacteria testing
// (Open / Warning / Closed per sampling site), matched to the beaches near each site.
// Pure functions, no DOM, so it can be tested in Node.

const WATER_NEAR_KM = 1; // without a hand-checked match, the nearest site this close speaks for the beach
const WATER_STALE_DAYS = 14; // older results get a "may be out of date" note
const RAIN_ADVISORY_MM = 2.5; // 0.1 inch of rain in the last 72 hours
const RAIN_ADVISORY_MS = 72 * 60 * 60 * 1000;

const WATER = typeof distanceKm === "function" ? { distanceKm } : require("./crowd.js");

const waterStatus = (text) => {
  const t = String(text || "").toLowerCase();
  if (/clos/.test(t)) return "closed";
  if (/warn|advis/.test(t)) return "warning";
  if (/open/.test(t)) return "open";
  return "unknown";
};

// The county's own note on a result, leaving out its routine "no oil observed" remarks.
function waterNote(text) {
  const note = String(text || "").replace(/\s+/g, " ").trim();
  return /did not observe/i.test(note) ? "" : note;
}

// ArcGIS query result -> [{ id, name, status, date, notes, results, lat, lon }].
function parseWaterStations(json) {
  return ((json && json.features) || []).map((f) => {
    const a = f.attributes || {};
    const g = f.geometry || {};
    return {
      id: a.Identifier,
      name: String(a.Beach_Name || "").trim(),
      status: waterStatus(a.Beach_status),
      date: typeof a.StatusDate === "number" ? a.StatusDate : null,
      notes: waterNote(a.Notes),
      results: { enterococcus: a.entercoccus_result, totalColiform: a.total_coliform_result, eColi: a.e_coli_result },
      lat: g.y,
      lon: g.x,
    };
  }).filter((s) => s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

// The sampling sites that speak for a beach: its hand-checked sites (beach.waterSites, county
// ids) when it has them, else the nearest site within WATER_NEAR_KM.
function waterFor(beach, stations) {
  const all = stations || [];
  if (beach.waterSites) return beach.waterSites.map((id) => all.find((s) => s.id === id)).filter(Boolean);
  const nearest = all
    .map((s) => ({ ...s, km: WATER.distanceKm(beach, s) }))
    .filter((s) => s.km <= WATER_NEAR_KM)
    .sort((a, b) => a.km - b.km)[0];
  return nearest ? [nearest] : [];
}

// The worst status among a beach's sites: closed > warning > open > unknown.
function worstWater(sites) {
  const rank = { closed: 3, warning: 2, open: 1, unknown: 0 };
  return (sites || []).reduce((worst, s) => (rank[s.status] > rank[worst] ? s.status : worst), "unknown");
}

const isStale = (site, now = Date.now()) => !site.date || now - site.date > WATER_STALE_DAYS * 24 * 60 * 60 * 1000;

// Rain (mm) in the 72 hours before `now`, from hourly weather [{ time, precipMm }].
function recentRainMm(hours, now = Date.now()) {
  return (hours || [])
    .filter((h) => h.time <= now && now - h.time <= RAIN_ADVISORY_MS)
    .reduce((mm, h) => mm + (h.precipMm || 0), 0);
}

if (typeof module !== "undefined") {
  module.exports = { WATER_NEAR_KM, RAIN_ADVISORY_MM, waterStatus, parseWaterStations, waterFor, worstWater, isStale, recentRainMm };
}
