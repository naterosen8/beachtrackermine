const test = require("node:test");
const assert = require("node:assert");
const { weekKey, cleanName, POINTS } = require("../js/points.js");

test("ISO week keys", () => {
  assert.strictEqual(weekKey(Date.UTC(2026, 9, 9)), "2026-W41"); // Friday Oct 9 2026
  assert.strictEqual(weekKey(Date.UTC(2026, 9, 5)), "2026-W41"); // Monday
  assert.strictEqual(weekKey(Date.UTC(2026, 9, 4, 23)), "2026-W40"); // Sunday night
  assert.strictEqual(weekKey(Date.UTC(2027, 0, 1)), "2026-W53"); // early January can belong to last year
  assert.strictEqual(weekKey(Date.UTC(2024, 11, 30)), "2025-W01"); // late December can belong to next year
});

test("nicknames", () => {
  assert.strictEqual(cleanName("  Sandy   Toes "), "Sandy Toes");
  assert.strictEqual(cleanName("José_99"), "José_99");
  assert.throws(() => cleanName("x"), /2 to 20/);
  assert.throws(() => cleanName("a".repeat(21)), /2 to 20/);
  assert.throws(() => cleanName("<script>"), /letters/);
  assert.throws(() => cleanName("Beachgoer 1A2B"), /own/);
  assert.deepStrictEqual(POINTS, { report: 10, up: 2, down: -2 });
});
