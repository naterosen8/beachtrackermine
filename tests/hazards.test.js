const test = require("node:test");
const assert = require("node:assert");
const { parseNwsAlerts, alertsForZone, hazardKey, ZONE_RE } = require("../js/hazards.js");
const real = require("./fixtures-nws.json"); // a real NWS response (Beach Hazards Statement, Oct 2026)

test("reads real NWS beach alerts", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T20:00:00Z") });
  const alerts = parseNwsAlerts(real);
  assert.ok(alerts.length >= 1);
  const a = alerts[0];
  assert.strictEqual(a.event, "Beach Hazards Statement");
  assert.match(a.what, /rip currents/);
  assert.ok(a.zones.includes("CAZ354"));
  assert.ok(a.ends > Date.now());
});

test("filters to beach events, current, actual; one per event per zone", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 14, 12) });
  const f = (event, zones, ends, status = "Actual") => ({ properties: { id: event + ends, event, status, ends, description: "* WHAT...Dangerous rip currents.\n\n* WHERE...Here.", affectedZones: zones.map((z) => `https://api.weather.gov/zones/forecast/${z}`) } });
  const alerts = parseNwsAlerts({ features: [
    f("Rip Current Statement", ["CAZ350"], "2026-10-15T00:00:00Z"),
    f("Rip Current Statement", ["CAZ350"], "2026-10-15T03:00:00Z"), // an update of the same
    f("High Surf Warning", ["CAZ350", "CAZ349"], "2026-10-15T00:00:00Z"),
    f("Wind Advisory", ["CAZ350"], "2026-10-15T00:00:00Z"), // not a beach event
    f("Rip Current Statement", ["CAZ350"], "2026-10-13T00:00:00Z"), // over
    f("High Surf Advisory", ["CAZ350"], "2026-10-15T00:00:00Z", "Test"), // a test message
  ] });
  assert.deepStrictEqual(alerts.map((a) => a.event), ["High Surf Warning", "Rip Current Statement", "Rip Current Statement"]);
  assert.strictEqual(alerts[1].what, "Dangerous rip currents.");
  assert.deepStrictEqual(alertsForZone(alerts, "CAZ350").map((a) => a.event), ["High Surf Warning", "Rip Current Statement"]);
  assert.deepStrictEqual(alertsForZone(alerts, "CAZ354"), []);
  assert.strictEqual(hazardKey(alerts[0]), "High Surf Warning|2026-10-15T00");
  assert.ok(ZONE_RE.test("CAZ350") && !ZONE_RE.test("CAZ35") && !ZONE_RE.test("x"));
});

test("a beach's NWS land zone: the point itself, else a few nearby points, cached", async (t) => {
  global.ZONE_RE = require("../js/hazards.js").ZONE_RE;
  const { getBeachZone } = require("../js/data.js");
  const store = {};
  global.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  t.after(() => { delete global.localStorage; });
  // On the sand: the first two lookups land in the marine zone, the third in the land zone.
  let calls = 0;
  const fake = async () => {
    calls++;
    return { features: calls < 3 ? [{ properties: { id: "PZZ650" } }] : [{ properties: { id: "CAZ354" } }] };
  };
  assert.strictEqual(await getBeachZone({ id: "osm:way/7", lat: 34.27, lon: -119.27 }, fake), "CAZ354");
  assert.strictEqual(calls, 3);
  assert.strictEqual(await getBeachZone({ id: "osm:way/7", lat: 34.27, lon: -119.27 }, fake), "CAZ354"); // cached
  assert.strictEqual(calls, 3);
  assert.strictEqual(await getBeachZone({ id: "x", zone: "CAZ350" }, fake), "CAZ350"); // hand-checked
  let n = 0;
  assert.strictEqual(await getBeachZone({ id: "osm:way/8", lat: 0, lon: 0 }, async () => { n++; return { features: [] }; }), null);
  assert.strictEqual(n, 9); // never more than 9 lookups
});
