const test = require("node:test");
const assert = require("node:assert");
const { alertReason, alertMessage, parseAlertSignup } = require("../js/alerts.js");

test("alerts when the crowd reaches the chosen level, or parking fills if asked", () => {
  assert.deepStrictEqual(alertReason({ crowd: 3.6, parking: null }, { level: 4 }), { crowd: true, parking: false });
  assert.strictEqual(alertReason({ crowd: 4.2, parking: "some" }, { level: 5 }), null);
  assert.deepStrictEqual(alertReason({ crowd: 2, parking: "full" }, { level: 5, parking: true }), { crowd: false, parking: true });
  assert.strictEqual(alertReason({ crowd: 2, parking: "full" }, { level: 5, parking: false }), null);
  assert.strictEqual(alertReason(null, { level: 4 }), null);
});

test("alert text says what beachgoers report", () => {
  const live = { crowd: 4.4, parking: "full", count: 2 };
  assert.deepStrictEqual(alertMessage("East Beach", live, { crowd: true, parking: true }), {
    title: "East Beach is busy",
    body: "2 beachgoers report it busy · parking full. Tap to see other beaches.",
  });
  assert.strictEqual(alertMessage("East Beach", { ...live, crowd: 2 }, { crowd: false, parking: true }).title, "Parking is full at East Beach");
});

const signup = (over = {}) => ({
  beachId: "osm:way/40117616",
  name: "East Beach",
  level: 4,
  parking: true,
  link: "/?beach=osm%3Away%2F40117616",
  subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNc-x_1", auth: "a2b" } },
  ...over,
});

test("accepts a real push subscription", () => {
  const { beachId, alert } = parseAlertSignup(signup());
  assert.strictEqual(beachId, "osm:way/40117616");
  assert.deepStrictEqual(alert, {
    sub: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNc-x_1", auth: "a2b" } },
    level: 4,
    parking: true,
    name: "East Beach",
    link: "/?beach=osm%3Away%2F40117616",
  });
  assert.ok(parseAlertSignup(signup({ subscription: { endpoint: "https://web.push.apple.com/QX", keys: { p256dh: "a", auth: "b" } } })));
});

test("refuses subscriptions that aren't browser push services, and bad values", () => {
  const bad = [
    signup({ subscription: { endpoint: "https://evil.example.com/fcm.googleapis.com", keys: { p256dh: "a", auth: "b" } } }),
    signup({ subscription: { endpoint: "http://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } } }),
    signup({ subscription: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a b", auth: "b" } } }),
    signup({ level: 3 }),
    signup({ beachId: "../x" }),
    signup({ name: "  " }),
  ];
  for (const body of bad) assert.throws(() => parseAlertSignup(body));
  // Links can only point inside the site.
  assert.strictEqual(parseAlertSignup(signup({ link: "//evil.example.com" })).alert.link, "/");
  assert.strictEqual(parseAlertSignup(signup({ link: "https://evil.example.com" })).alert.link, "/");
});
