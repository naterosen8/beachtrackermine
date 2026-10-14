const test = require("node:test");
const assert = require("node:assert");
const { parseSweepSchedule, nextSweeping, sweepRoutesNear, metresToLine } = require("../js/sweeping.js");

test("reads every schedule wording the city uses", () => {
  assert.deepStrictEqual(parseSweepSchedule("Mondays 10am – 12pm"), { days: [1], nth: null, start: { h: 10, m: 0 }, end: { h: 12, m: 0 } });
  assert.deepStrictEqual(parseSweepSchedule("Mondays/Wednesdays/Fridays 1am – 4am").days, [1, 3, 5]);
  assert.deepStrictEqual(parseSweepSchedule("1st & 3rd Mondays 6:30am – 7:30am"), { days: [1], nth: [1, 3], start: { h: 6, m: 30 }, end: { h: 7, m: 30 } });
  assert.deepStrictEqual(parseSweepSchedule("2nd & 4th Fridays 8am - 9am").end, { h: 9, m: 0 }); // plain hyphen too
  assert.deepStrictEqual(parseSweepSchedule("2nd & 4th Tuesdays"), { days: [2], nth: [2, 4], start: null, end: null });
  assert.deepStrictEqual(parseSweepSchedule("Not Swept"), { notSwept: true });
  assert.deepStrictEqual(parseSweepSchedule("Wednesdays 2x A Month"), { unknown: true }); // which Wednesdays isn't said
  assert.deepStrictEqual(parseSweepSchedule("Thursdays 1pm – 4pm").start, { h: 13, m: 0 });
  assert.deepStrictEqual(parseSweepSchedule(""), { unknown: true });
});

test("finds the next sweeping, including nth-weekday schedules", () => {
  const wed = new Date(2026, 9, 14, 12); // Wednesday Oct 14 2026, noon
  const next = nextSweeping(parseSweepSchedule("Mondays 10am – 12pm"), wed);
  assert.deepStrictEqual([next.start.getMonth(), next.start.getDate(), next.start.getHours(), next.end.getHours()], [9, 19, 10, 12]);
  // 1st & 3rd Fridays: Oct 2 and Oct 16 → the 16th.
  assert.strictEqual(nextSweeping(parseSweepSchedule("1st & 3rd Fridays 8am – 12pm"), wed).start.getDate(), 16);
  // 2nd & 4th Mondays: Oct 12 (past) and Oct 26.
  const nth = nextSweeping(parseSweepSchedule("2nd & 4th Mondays"), wed);
  assert.strictEqual(nth.start.getDate(), 26);
  assert.strictEqual(nth.timed, false);
  // Under way right now still counts: Wednesday 1pm–4pm at 2pm.
  assert.strictEqual(nextSweeping(parseSweepSchedule("Wednesdays 1pm – 4pm"), new Date(2026, 9, 14, 14)).start.getDate(), 14);
  assert.strictEqual(nextSweeping(parseSweepSchedule("Wednesdays 2x A Month"), wed), null);
  assert.strictEqual(nextSweeping({ notSwept: true }, wed), null);
});

test("picks the street you're on, and both sides when they differ", () => {
  const here = { lat: 34.4145, lon: -119.6815 };
  const line = (dLat, schedule, type = "Residential") => ({
    attributes: { Schedule: schedule, Route_Type: type },
    geometry: { paths: [[[here.lon - 0.001, here.lat + dLat], [here.lon + 0.001, here.lat + dLat]]] },
  });
  assert.ok(Math.abs(metresToLine(here, line(0.0001, "x").geometry.paths[0]) - 11.05) < 0.2);
  const routes = sweepRoutesNear(here, [
    line(0.00005, "Mondays 10am – 12pm"), // ~5.5 m: this side
    line(-0.0001, "Tuesdays 10am – 12pm"), // ~11 m: other side, within 10 m of the nearest
    line(0.00006, "Mondays 10am – 12pm"), // duplicate schedule
    line(0.001, "Fridays 1am – 4am", "Commercial"), // ~110 m: a different street
  ]);
  assert.deepStrictEqual(routes.map((r) => r.schedule), ["Mondays 10am – 12pm", "Tuesdays 10am – 12pm"]);
  assert.deepStrictEqual(sweepRoutesNear(here, [line(0.001, "Mondays 10am – 12pm")]), []);
});
