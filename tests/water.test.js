const test = require("node:test");
const assert = require("node:assert");
const { waterStatus, parseWaterStations, waterFor, worstWater, isStale, recentRainMm } = require("../js/water.js");

// Shaped like the county's ArcGIS layer (October 2026).
const SAMPLE = {
  features: [
    { attributes: { Identifier: "WP0000007", Beach_Name: "Leadbetter", Beach_status: "Warning", StatusDate: Date.UTC(2026, 9, 5, 8), Notes: "Results exceed geomean state standard,\nsample still in warning", entercoccus_result: "10", total_coliform_result: "170", e_coli_result: "86" }, geometry: { x: -119.6970867586134, y: 34.40191410180261 } },
    { attributes: { Identifier: "WP0000085", Beach_Name: "East Beach @ Mission Creek", Beach_status: "Open", StatusDate: Date.UTC(2026, 9, 5, 8), Notes: null }, geometry: { x: -119.6862338161467, y: 34.412087570786134 } },
    { attributes: { Identifier: "WP0000083", Beach_Name: "East Beach @ Sycamore Creek", Beach_status: "Warning", StatusDate: Date.UTC(2026, 9, 5, 8) }, geometry: { x: -119.66674662029314, y: 34.41651417024213 } },
    { attributes: { Identifier: "X", Beach_Name: "", Beach_status: "Open" }, geometry: { x: 0, y: 0 } },
  ],
};

test("reads the county's sampling sites", () => {
  const sites = parseWaterStations(SAMPLE);
  assert.strictEqual(sites.length, 3);
  assert.deepStrictEqual(sites[0], {
    id: "WP0000007", name: "Leadbetter", status: "warning", date: Date.UTC(2026, 9, 5, 8),
    notes: "Results exceed geomean state standard, sample still in warning",
    results: { enterococcus: "10", totalColiform: "170", eColi: "86" },
    lat: 34.40191410180261, lon: -119.6970867586134,
  });
  assert.deepStrictEqual(parseWaterStations(null), []);
});

test("statuses in plain words", () => {
  assert.strictEqual(waterStatus("Open"), "open");
  assert.strictEqual(waterStatus("Warning"), "warning");
  assert.strictEqual(waterStatus("CLOSED"), "closed");
  assert.strictEqual(waterStatus("Advisory"), "warning");
  assert.strictEqual(waterStatus(null), "unknown");
});

test("uses a beach's hand-checked sites, else the nearest one close by", () => {
  const sites = parseWaterStations(SAMPLE);
  // East Beach is long, with a site at each creek.
  const east = waterFor({ lat: 34.4145, lon: -119.6815, waterSites: ["WP0000085", "WP0000083", "gone"] }, sites);
  assert.deepStrictEqual(east.map((s) => s.name), ["East Beach @ Mission Creek", "East Beach @ Sycamore Creek"]);
  assert.strictEqual(worstWater(east), "warning");
  // A hand-checked beach with no site doesn't borrow a neighbour's.
  assert.deepStrictEqual(waterFor({ lat: 34.4096, lon: -119.6909, waterSites: [] }, sites), []);
  // Map beaches: only the single nearest site within 1 km.
  assert.deepStrictEqual(waterFor({ lat: 34.402, lon: -119.698 }, sites).map((s) => s.id), ["WP0000007"]);
  assert.deepStrictEqual(waterFor({ lat: 34.4071, lon: -119.8499 }, sites), []);
  assert.strictEqual(worstWater([]), "unknown");
});

test("drops the county's routine oil-check notes", () => {
  const [site] = parseWaterStations({ features: [{ attributes: { Beach_Name: "Hammonds", Beach_status: "Open", Notes: "During sampling, EHS staff did not observe increased amounts of oil." }, geometry: { x: -119.6, y: 34.4 } }] });
  assert.strictEqual(site.notes, "");
});

test("old results and recent rain", () => {
  const now = Date.UTC(2026, 9, 9);
  assert.strictEqual(isStale({ date: Date.UTC(2026, 9, 5) }, now), false);
  assert.strictEqual(isStale({ date: Date.UTC(2026, 8, 1) }, now), true);
  const H = 3600e3;
  const hours = [{ time: now - 80 * H, precipMm: 9 }, { time: now - 10 * H, precipMm: 1.5 }, { time: now - 2 * H, precipMm: 1.2 }, { time: now + H, precipMm: 5 }];
  assert.ok(Math.abs(recentRainMm(hours, now) - 2.7) < 1e-9); // only the past 72 hours count
});
