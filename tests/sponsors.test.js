const test = require("node:test");
const assert = require("node:assert");
const { SPONSORS, ADVERTISE, paidUp, activeSponsors, sponsorForSpot, sponsorForBeach } = require("../js/sponsors.js");

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const shop = (name, paidThrough, extra) => ({ name, url: `https://${name.toLowerCase()}.example`, paidThrough, ...extra });

test("an ad runs through the end of its paid day, then stops by itself", () => {
  assert.ok(paidUp("2026-11-30", at(2026, 11, 30, 23)));
  assert.ok(!paidUp("2026-11-30", at(2026, 12, 1, 0)));
  assert.ok(!paidUp("", at(2026, 11, 1)));
  assert.ok(!paidUp("Nov 30", at(2026, 11, 1)));
});

test("only paid-up sponsors with a name and an https link show", () => {
  const now = at(2026, 11, 15);
  const list = [
    shop("Paid", "2026-11-30"),
    shop("Lapsed", "2026-10-31"),
    { name: "Unsafe", url: "javascript:alert(1)", paidThrough: "2026-11-30" },
    { url: "https://noname.example", paidThrough: "2026-11-30" },
  ];
  assert.deepStrictEqual(activeSponsors(list, now).map((s) => s.name), ["Paid"]);
});

test("the sponsor spot rotates hourly so every sponsor gets a share", () => {
  const list = [shop("A", "2026-11-30"), shop("B", "2026-11-30")];
  const seen = new Set([0, 1, 2, 3].map((h) => sponsorForSpot(list, at(2026, 11, 15, h)).name));
  assert.deepStrictEqual([...seen].sort(), ["A", "B"]);
  assert.strictEqual(sponsorForSpot([], at(2026, 11, 15)), null);
});

test("a card shows only a sponsor that paid for that beach", () => {
  const now = at(2026, 11, 15);
  const list = [shop("Everywhere", "2026-11-30"), shop("DevsShop", "2026-11-30", { beaches: ["osm:way/551452844"] })];
  assert.strictEqual(sponsorForBeach(list, "osm:way/551452844", now).name, "DevsShop");
  assert.strictEqual(sponsorForBeach(list, "osm:way/551452843", now), null);
});

test("the sponsor list and sign-up settings are well formed", () => {
  for (const s of SPONSORS) {
    assert.match(s.paidThrough, /^\d{4}-\d{2}-\d{2}$/, s.name);
    assert.match(s.url, /^https:\/\//, s.name);
  }
  assert.ok(!ADVERTISE.paymentLink || /^https:\/\//.test(ADVERTISE.paymentLink));
});
