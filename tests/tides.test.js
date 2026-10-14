const test = require("node:test");
const assert = require("node:assert");
const { nearestTideStation, parseNoaaTides, tideFromTurns, turnsOnDay } = require("../js/tides.js");

test("each beach uses its nearest NOAA station, within 40 km", () => {
  assert.deepStrictEqual(Object.values(nearestTideStation({ lat: 34.4145, lon: -119.6815 })).slice(0, 2), ["9411340", "Santa Barbara"]); // East Beach
  assert.strictEqual(nearestTideStation({ lat: 34.3767, lon: -119.4807 }).name, "Rincon Island, Mussel Shoals"); // Rincon
  assert.strictEqual(nearestTideStation({ lat: 40.7, lon: -74 }), null); // New York: no California station near
});

// NOAA's answer for Santa Barbara, Oct 14 2026 (times in GMT).
const NOAA = { predictions: [
  { t: "2026-10-14 08:00", v: "3.529", type: "H" },
  { t: "2026-10-14 12:03", v: "2.759", type: "L" },
  { t: "2026-10-14 18:30", v: "5.468", type: "H" },
  { t: "2026-10-15 02:15", v: "0.509", type: "L" },
  { t: "bad", v: "1", type: "H" },
] };

test("reads NOAA high and low tides", () => {
  const turns = parseNoaaTides(NOAA);
  assert.strictEqual(turns.length, 4);
  assert.deepStrictEqual(turns[2], { type: "high", time: Date.UTC(2026, 9, 14, 18, 30), ft: 5.468 });
  assert.deepStrictEqual(parseNoaaTides({ error: { message: "No data" } }), []);
});

test("rising or falling, and what comes next", () => {
  const turns = parseNoaaTides(NOAA);
  const t = tideFromTurns(turns, Date.UTC(2026, 9, 14, 14));
  assert.strictEqual(t.rising, true);
  assert.strictEqual(t.next.ft, 5.468);
  assert.strictEqual(t.after.type, "low");
  assert.strictEqual(tideFromTurns(turns, Date.UTC(2026, 9, 16)), null);
  assert.strictEqual(turnsOnDay(turns, Date.UTC(2026, 9, 14, 12)).length >= 2, true);
});
