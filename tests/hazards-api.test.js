const test = require("node:test");
const assert = require("node:assert");
const handler = require("../api/hazards.js");

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNc", auth: "a2b" } };
const EAST = { id: "osm:way/40117616", name: "East Beach", lat: 34.4145, lon: -119.6815, zone: "CAZ350", waterSites: ["WP0000083"] };

function fakeRes() {
  return { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

function setup(t, answer, { alerts = [], water = { features: [] } } = {}) {
  Object.assign(process.env, { UPSTASH_REDIS_REST_URL: "https://store.test", UPSTASH_REDIS_REST_TOKEN: "t", VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", CRON_SECRET: "s3cret" });
  t.after(() => { for (const k of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "CRON_SECRET"]) delete process.env[k]; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    const commands = JSON.parse(opts.body);
    calls.push(commands);
    return { ok: true, json: async () => commands.map((c) => ({ result: answer(c) })) };
  });
  const asked = [];
  t.mock.method(handler, "fetchJson", async (url) => { asked.push(url); return /weather\.gov/.test(url) ? { features: alerts } : water; });
  const pushes = [];
  t.mock.method(handler, "sendPush", async (sub, payload) => { pushes.push({ endpoint: sub.endpoint, ...payload }); return sub.endpoint.endsWith("gone") ? 410 : 201; });
  return { calls, pushes, asked };
}

const nws = (event, zones, ends = new Date(Date.now() + 6 * 3600e3).toISOString()) => ({ properties: { id: event, event, status: "Actual", ends, headline: `${event} issued`, description: "* WHAT...Dangerous rip currents expected.\n\n* WHERE...Here.", affectedZones: zones.map((z) => `https://api.weather.gov/zones/forecast/${z}`) } });

test("sign-up stores the starred beaches with their zones and confirms by push", async (t) => {
  const { calls, pushes } = setup(t, (c) => (c[0] === "INCR" ? 1 : c[0] === "HLEN" ? 0 : "OK"));
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: { subscription: SUB, beaches: [EAST, { ...EAST, id: "osm:way/1", zone: "bad zone" }] } }, res);
  assert.strictEqual(res.statusCode, 200);
  const saved = JSON.parse(calls.find((c) => c[0][0] === "HSET")[0][3]);
  assert.strictEqual(saved.beaches[0].zone, "CAZ350");
  assert.strictEqual(saved.beaches[1].zone, undefined); // invalid zones are dropped
  assert.strictEqual(pushes[0].title, "Safety alerts are on 🚨");
});

test("the check needs the secret", async (t) => {
  setup(t, () => []);
  const res = fakeRes();
  await handler({ method: "GET", headers: { authorization: "Bearer nope" } }, res);
  assert.strictEqual(res.statusCode, 401);
});

test("pushes each NWS hazard and county closure once, and drops dead subscriptions", async (t) => {
  const entry = (endpoint) => JSON.stringify({ sub: { ...SUB, endpoint }, beaches: [EAST] });
  const sentKeys = new Set();
  const { pushes, calls, asked } = setup(t, (c) => {
    if (c[0] === "HGETALL") return ["f1", entry("https://fcm.googleapis.com/ok"), "f2", entry("https://fcm.googleapis.com/gone")];
    if (c[0] === "SET") { if (sentKeys.has(c[1])) return null; sentKeys.add(c[1]); return "OK"; }
    return 1;
  }, {
    alerts: [nws("Rip Current Statement", ["CAZ350"]), nws("High Surf Advisory", ["CAZ354"])],
    water: { features: [{ attributes: { Identifier: "WP0000083", Beach_Name: "East Beach @ Sycamore Creek", Beach_status: "Closed", StatusDate: Date.UTC(2026, 9, 14) }, geometry: { x: -119.6667, y: 34.4165 } }] },
  });
  const run = async () => { const res = fakeRes(); await handler({ method: "GET", headers: { authorization: "Bearer s3cret" } }, res); return res; };
  const first = await run();
  assert.strictEqual(first.statusCode, 200);
  assert.match(asked[0], /alerts\/active\?status=actual&zone=CAZ350$/);
  assert.deepStrictEqual(pushes.filter((p) => p.endpoint.endsWith("ok")).map((p) => p.title), ["Rip Current Statement: East Beach", "Closed to swimming: East Beach"]);
  assert.match(pushes[0].body, /^Dangerous rip currents expected\. until .+\. From the National Weather Service\.$/);
  assert.match(pushes[0].url, /beach=osm%3Away%2F40117616/);
  assert.deepStrictEqual(first.body, { subscribers: 2, alerts: 2, sent: 2, removed: 1 });
  assert.deepStrictEqual(calls[calls.length - 1], [["HDEL", "hazards", "f2"]]);
  // A second run 15 minutes later sends nothing new.
  pushes.length = 0;
  await run();
  assert.strictEqual(pushes.filter((p) => p.endpoint.endsWith("ok")).length, 0);
});
