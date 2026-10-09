const test = require("node:test");
const assert = require("node:assert");
const { parseBeaches, cleanTimeZone, beachLine, summaryMessage, inTimeZone } = require("../api/_summary.js");
const handler = require("../api/morning.js");

const EAST = { id: "osm:way/40117616", name: "East Beach", lat: 34.4145, lon: -119.6815, waterSites: ["WP0000085", "WP0000083"] };
const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNc", auth: "a2b" } };

test("checks the starred beaches and time zone sent from the page", () => {
  assert.deepStrictEqual(parseBeaches([{ ...EAST, waterSites: ["WP0000085", "bad"] }]), [{ ...EAST, waterSites: ["WP0000085"] }]);
  assert.throws(() => parseBeaches([]), /Star at least one/);
  assert.throws(() => parseBeaches([{ id: "x", name: "A", lat: 1, lon: 1 }]), /Unknown beach/);
  assert.throws(() => parseBeaches([{ ...EAST, lat: 200 }]), /Bad beach/);
  assert.strictEqual(parseBeaches(Array(15).fill(EAST)).length, 10);
  assert.strictEqual(cleanTimeZone("America/New_York"), "America/New_York");
  assert.strictEqual(cleanTimeZone("Mars/Olympus"), "America/Los_Angeles");
});

test("a beach's line: busy hours, afternoon weather and water warnings", () => {
  const day = inTimeZone("America/Los_Angeles", () => new Date(2026, 6, 11, 7).getTime()); // a July Saturday
  const warm = () => ({ tempC: 26, precipProb: 10 });
  const water = [{ id: "WP0000083", name: "East Beach @ Sycamore Creek", status: "warning", lat: 34.4165, lon: -119.6667 }];
  const line = inTimeZone("America/Los_Angeles", () => beachLine(EAST, { day, weatherFor: warm, water }));
  assert.match(line, /^East Beach: busy \d+(–\d+)? ?(AM|PM)?–\d+ PM · 79°F · water quality warning$/);
  const winter = inTimeZone("America/Los_Angeles", () => beachLine(EAST, { day: new Date(2026, 0, 13, 7).getTime(), weatherFor: () => ({ tempC: 12, precipProb: 70 }) }));
  assert.strictEqual(winter, "East Beach: quiet all day · 54°F · 70% rain");
});

test("the message lists up to four beaches", () => {
  const beaches = ["A", "B", "C", "D", "E"].map((n, i) => ({ ...EAST, id: `osm:way/${i + 1}`, name: `${n} Beach` }));
  const msg = inTimeZone("America/Los_Angeles", () => summaryMessage(beaches, () => ({}), new Date(2026, 0, 13, 7).getTime()));
  assert.strictEqual(msg.title, "Your beaches Tuesday");
  assert.strictEqual(msg.body.split("\n").length, 5);
  assert.match(msg.body, /\n\+1 more$/);
});

// --- the endpoint -------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function setup(t, answer) {
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: "https://store.test", UPSTASH_REDIS_REST_TOKEN: "t", VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", CRON_SECRET: "s3cret" });
  t.after(() => { for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "CRON_SECRET"]) delete process.env[k]; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    const commands = JSON.parse(opts.body);
    calls.push(commands);
    return { ok: true, json: async () => commands.map((c) => ({ result: answer(c) })) };
  });
  t.mock.method(handler, "fetchJson", async () => { throw new Error("offline"); }); // no weather in tests
  const pushes = [];
  t.mock.method(handler, "sendPush", async (sub, payload) => { pushes.push({ endpoint: sub.endpoint, ...payload }); return sub.endpoint.endsWith("gone") ? 410 : 201; });
  return { calls, pushes };
}

test("signing up stores the subscriber and sends a first summary right away", async (t) => {
  const { calls, pushes } = setup(t, (c) => (c[0] === "INCR" ? 1 : c[0] === "HLEN" ? 0 : c[0] === "HGETALL" ? [] : "OK"));
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: { subscription: SUB, beaches: [EAST], tz: "America/Los_Angeles", link: "/?beach=x" } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.body.preview.body, /^East Beach: /);
  const hset = calls.find((cmds) => cmds[0][0] === "HSET")[0];
  assert.strictEqual(hset[1], "morning");
  assert.deepStrictEqual(JSON.parse(hset[3]).beaches, [EAST]);
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0].title, "Morning summary is on ☀️");
  assert.strictEqual(pushes[0].url, "/?beach=x");
});

test("the daily run needs the cron secret", async (t) => {
  setup(t, () => []);
  for (const auth of [undefined, "Bearer wrong"]) {
    const res = fakeRes();
    await handler({ method: "GET", headers: { authorization: auth } }, res);
    assert.strictEqual(res.statusCode, 401);
  }
});

test("the daily run sends to people in their morning and drops dead subscriptions", async (t) => {
  const hourNow = (tz) => handler.localHour(tz);
  // Pick time zones where it's morning / not morning right now, whatever the test's clock says.
  const zones = ["Pacific/Honolulu", "America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Sydney", "Pacific/Kiritimati", "America/Sao_Paulo", "Asia/Kolkata", "Africa/Cairo", "Asia/Bangkok", "Pacific/Auckland"];
  const morning = zones.find((z) => hourNow(z) >= 6 && hourNow(z) < 11) || "Etc/GMT";
  const night = zones.find((z) => hourNow(z) < 6 || hourNow(z) >= 11);
  const entry = (endpoint, tz) => JSON.stringify({ sub: { ...SUB, endpoint }, beaches: [EAST], tz, link: "/" });
  const { calls, pushes } = setup(t, (c) => {
    if (c[0] === "HGETALL" && c[1] === "morning") {
      return ["f1", entry("https://fcm.googleapis.com/ok", morning), "f2", entry("https://fcm.googleapis.com/gone", morning), "f3", entry("https://fcm.googleapis.com/late", night), "f4", "junk"];
    }
    return c[0] === "HGETALL" ? [] : 1;
  });
  const res = fakeRes();
  await handler({ method: "GET", headers: { authorization: "Bearer s3cret" } }, res);
  assert.strictEqual(res.statusCode, 200);
  if (hourNow(morning) >= 6 && hourNow(morning) < 11) {
    assert.deepStrictEqual(res.body, { sent: 1, skipped: 1, removed: 1 });
    assert.deepStrictEqual(pushes.map((p) => p.endpoint), ["https://fcm.googleapis.com/ok", "https://fcm.googleapis.com/gone"]);
    assert.match(pushes[0].title, /^Your beaches /);
    assert.deepStrictEqual(calls[calls.length - 1], [["HDEL", "morning", "f2"]]);
  }
});
