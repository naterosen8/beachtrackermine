const test = require("node:test");
const assert = require("node:assert");
const {
  crowdLabel, distanceKm, driveMinutes, slotKey, liveStatus, seasonFactor, weatherFactor, estimateCrowd,
} = require("../js/crowd.js");

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 6, 11, 20); // a Saturday in July
// Local-time dates, so tests don't depend on the machine's time zone.
const saturday = (hour) => new Date(2026, 6, 11, hour);
const tuesday = (hour) => new Date(2026, 6, 14, hour);
const warm = { tempC: 28, precipMm: 0, precipProb: 5, windKmh: 10 };

test("distance and drive time are sensible", () => {
  const santaMonica = { lat: 34.0094, lon: -118.4973 };
  const hermosa = { lat: 33.8622, lon: -118.4012 };
  const km = distanceKm(santaMonica, hermosa);
  assert.ok(km > 18 && km < 19, `got ${km}`);
  assert.strictEqual(driveMinutes(km), 25);
  assert.strictEqual(driveMinutes(0), 1);
});

test("crowd labels clamp and round", () => {
  assert.strictEqual(crowdLabel(1), "Empty");
  assert.strictEqual(crowdLabel(3.4), "Moderate");
  assert.strictEqual(crowdLabel(4.6), "Packed");
  assert.strictEqual(crowdLabel(9), "Packed");
});

test("slot key groups by weekend and hour", () => {
  assert.strictEqual(slotKey(saturday(14)), "we:14");
  assert.strictEqual(slotKey(tuesday(9)), "wd:9");
});

test("no recent reports means no live status", () => {
  assert.strictEqual(liveStatus([], NOW), null);
  assert.strictEqual(liveStatus([{ time: NOW - 4 * 60 * MIN, crowd: 5 }], NOW), null);
});

test("newer reports outweigh older ones", () => {
  const live = liveStatus([
    { time: NOW - 2 * MIN, crowd: 5, parking: "full" },
    { time: NOW - 120 * MIN, crowd: 1, parking: "plenty" },
    { time: NOW - 130 * MIN, crowd: 1, parking: "plenty" },
  ], NOW);
  assert.strictEqual(live.count, 3);
  assert.ok(live.crowd > 4, `got ${live.crowd}`);
  assert.strictEqual(live.parking, "full");
  assert.strictEqual(live.newest, NOW - 2 * MIN);
});

test("live status keeps the latest notes", () => {
  const live = liveStatus([
    { time: NOW - 30 * MIN, crowd: 3, note: "older" },
    { time: NOW - 5 * MIN, crowd: 3, note: "newer" },
    { time: NOW - 10 * MIN, crowd: 3 },
  ], NOW);
  assert.deepStrictEqual(live.notes.map((n) => n.note), ["newer", "older"]);
});

test("seasons flip south of the equator", () => {
  assert.strictEqual(seasonFactor(6, 34), 1); // July, California
  assert.strictEqual(seasonFactor(0, -33.9), 1); // January, Sydney
  assert.strictEqual(seasonFactor(0, 34), 0.2);
  assert.strictEqual(seasonFactor(0, 10), 0.85); // tropics
});

test("bad weather keeps people away", () => {
  assert.strictEqual(weatherFactor(warm).factor, 1);
  assert.ok(weatherFactor({ tempC: 12 }).factor < 0.5);
  const rain = weatherFactor({ tempC: 28, precipMm: 3 });
  assert.ok(rain.factor < 0.5);
  assert.ok(rain.reasons.includes("Raining"));
  assert.strictEqual(weatherFactor(null).factor, 1);
});

test("summer weekend afternoons are busiest", () => {
  const peak = estimateCrowd({ date: saturday(13), lat: 34, weather: warm });
  const weekday = estimateCrowd({ date: tuesday(13), lat: 34, weather: warm });
  const morning = estimateCrowd({ date: saturday(8), lat: 34, weather: warm });
  const night = estimateCrowd({ date: saturday(23), lat: 34, weather: warm });
  assert.ok(peak.crowd >= 4.5, `peak ${peak.crowd}`);
  assert.ok(weekday.crowd < peak.crowd);
  assert.ok(morning.crowd < 2.5, `morning ${morning.crowd}`);
  assert.strictEqual(night.crowd, 1);
  assert.deepStrictEqual(peak.reasons, ["Weekend afternoon", "Peak season", "Warm"]);
});

test("past reports pull the estimate toward what people saw", () => {
  const plain = estimateCrowd({ date: saturday(13), lat: 34, weather: warm });
  const history = { "we:13": { sum: 20, count: 10 } }; // usually Quiet at this time
  const learned = estimateCrowd({ date: saturday(13), lat: 34, weather: warm, history });
  assert.ok(learned.crowd < plain.crowd - 2, `learned ${learned.crowd}`);
  assert.strictEqual(learned.fromHistory, 10);
  assert.ok(learned.reasons.includes("10 past reports at this time"));
});

test("too few past reports are ignored", () => {
  const history = { "we:13": { sum: 2, count: 2 } };
  const r = estimateCrowd({ date: saturday(13), lat: 34, weather: warm, history });
  assert.strictEqual(r.fromHistory, 0);
});

test("votes: upvoted reports count more, flagged ones not at all", () => {
  const { liveStatus, isFlagged, voteWeight, recentReports } = require("../js/crowd.js");
  const now = Date.now();
  assert.strictEqual(voteWeight({}), 1);
  assert.strictEqual(voteWeight({ up: 2 }), 1.5);
  assert.strictEqual(voteWeight({ up: 10 }), 2);
  assert.strictEqual(voteWeight({ up: 1, down: 2 }), 0);
  assert.strictEqual(voteWeight({ down: 1 }), 0.5);
  assert.strictEqual(isFlagged({ up: 2, down: 2 }), false); // a tie isn't enough to hide it
  const reports = [
    { time: now, crowd: 5, down: 3 }, // flagged: ignored
    { time: now, crowd: 1, up: 4 },
    { time: now, crowd: 3 },
  ];
  const live = liveStatus(reports, now);
  assert.strictEqual(live.count, 2);
  assert.ok(Math.abs(live.crowd - (1 * 2 + 3 * 1) / 3) < 1e-9);
  assert.strictEqual(liveStatus([{ time: now, crowd: 5, down: 2 }], now), null);
  assert.strictEqual(recentReports(reports, now).length, 3); // still listed, marked flagged in the UI
});
