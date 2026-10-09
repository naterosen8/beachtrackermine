// The morning summary for someone's starred beaches: what the day looks like at each, from the same
// forecast the page uses (js/conditions.js), plus water quality warnings. Pure apart from the
// fetches in loadConditions().

const { dayForecast, rangeText } = require("../js/conditions.js");
const { crowdLabel, distanceKm } = require("../js/crowd.js");
const { parseWaterStations, waterFor, worstWater } = require("../js/water.js");

const BUSY = 3.5; // same as the page's "busy" line
const MAX_BEACHES = 10;
const ID_RE = /^(osm:(node|way|relation)\/\d{1,15}|demo:[a-z0-9-]{1,40})$/;

// Starred beaches sent from the page: [{ id, name, lat, lon, waterSites? }], checked.
function parseBeaches(list) {
  if (!Array.isArray(list) || !list.length) throw new Error("Star at least one beach first.");
  return list.slice(0, MAX_BEACHES).map((b) => {
    if (!b || typeof b.id !== "string" || !ID_RE.test(b.id)) throw new Error("Unknown beach");
    const name = typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    if (!name || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) throw new Error("Bad beach");
    const out = { id: b.id, name, lat, lon };
    if (Array.isArray(b.waterSites)) out.waterSites = b.waterSites.filter((w) => /^WP\d{7}$/.test(w)).slice(0, 4);
    return out;
  });
}

// A valid IANA time zone, else Pacific.
function cleanTimeZone(tz) {
  try {
    if (typeof tz === "string" && tz.length < 60) {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    }
  } catch {
    // fall through
  }
  return "America/Los_Angeles";
}

// One line for a beach, e.g. "East Beach: busy 12–5 PM · 68°F · water quality warning".
// Dates are in process.env.TZ, which the caller sets to the subscriber's time zone.
function beachLine(beach, { day, weatherFor, history, water }) {
  const hours = dayForecast({ day, lat: beach.lat, weatherFor, history });
  const busy = hours.filter((h) => h.crowd >= BUSY);
  const peak = hours.reduce((a, b) => (b.crowd > a.crowd ? b : a), hours[0]);
  const bits = [busy.length
    ? `busy ${rangeText(busy[0].hour, busy[busy.length - 1].hour + 1)}`
    : peak.crowd < 2.5 ? "quiet all day" : `${crowdLabel(peak.crowd).toLowerCase()} at most`];
  const afternoon = weatherFor && weatherFor(new Date(day).setHours(13, 0, 0, 0));
  if (afternoon && typeof afternoon.tempC === "number") {
    bits.push(`${Math.round(afternoon.tempC * 1.8 + 32)}°F`);
    if (afternoon.precipProb >= 40) bits.push(`${Math.round(afternoon.precipProb)}% rain`);
  }
  const level = worstWater(waterFor(beach, water || []));
  if (level === "warning") bits.push("water quality warning");
  if (level === "closed") bits.push("closed to swimming");
  return `${beach.name}: ${bits.join(" · ")}`;
}

function summaryMessage(beaches, conditions, day) {
  const lines = beaches.map((b) => beachLine(b, { day, ...conditions(b) }));
  const weekday = new Date(day).toLocaleDateString("en-US", { weekday: "long" });
  return { title: `Your beaches ${weekday}`, body: lines.slice(0, 4).join("\n") + (lines.length > 4 ? `\n+${lines.length - 4} more` : "") };
}

// Weather (Open-Meteo, hourly, today) by rounded location, and the county's water testing when
// any beach is in Santa Barbara County. Failures just leave those parts out.
const SB_COUNTY_BOX = { south: 34.3, north: 35.15, west: -120.7, east: -119.4 };
async function loadConditions(beaches, fetchJson) {
  const weather = new Map();
  const spots = [...new Set(beaches.map((b) => `${b.lat.toFixed(1)},${b.lon.toFixed(1)}`))];
  await Promise.all(spots.map(async (spot) => {
    const [lat, lon] = spot.split(",");
    try {
      const json = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m&forecast_days=2&timeformat=unixtime`);
      const h = json.hourly;
      weather.set(spot, h.time.map((t, i) => ({ time: t * 1000, tempC: h.temperature_2m[i], precipProb: h.precipitation_probability[i], precipMm: h.precipitation[i], windKmh: h.wind_speed_10m[i] })));
    } catch {
      // no weather for this spot
    }
  }));
  let water = [];
  if (beaches.some((b) => b.lat >= SB_COUNTY_BOX.south && b.lat <= SB_COUNTY_BOX.north && b.lon >= SB_COUNTY_BOX.west && b.lon <= SB_COUNTY_BOX.east)) {
    try {
      water = parseWaterStations(await fetchJson("https://services.arcgis.com/KkJhFbLnXVqahKz2/arcgis/rest/services/Ocean_Water_Quality_Points_Public/FeatureServer/0/query?where=1%3D1&outFields=Identifier,Beach_Name,Beach_status,StatusDate,Notes&returnGeometry=true&outSR=4326&f=json"));
    } catch {
      // no water quality today
    }
  }
  const closest = (hours, t) => hours.reduce((a, b) => (Math.abs(b.time - t) < Math.abs(a.time - t) ? b : a));
  return (beach) => {
    const hours = weather.get(`${beach.lat.toFixed(1)},${beach.lon.toFixed(1)}`);
    return { weatherFor: hours && hours.length ? (t) => closest(hours, t) : null, water };
  };
}

async function fetchJsonNode(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

// Runs `fn` with dates in the given time zone (Node reads process.env.TZ on each change).
function inTimeZone(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

module.exports = { parseBeaches, cleanTimeZone, beachLine, summaryMessage, loadConditions, fetchJsonNode, inTimeZone, distanceKm };
