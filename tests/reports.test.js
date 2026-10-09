const test = require("node:test");
const assert = require("node:assert");
const handler = require("../api/reports.js");
const { parseReport, parseHistory } = handler;

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// Stands in for Upstash: records each pipeline and answers with canned results.
function fakeStore(t, answer) {
  process.env.UPSTASH_REDIS_REST_URL = "https://store.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  t.after(() => { delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN; });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    const commands = JSON.parse(opts.body);
    calls.push(commands);
    return { ok: true, json: async () => commands.map((c) => ({ result: answer(c) })) };
  });
  return calls;
}

test("parseReport accepts a good report and trims the note", () => {
  const r = parseReport({ beachId: "osm:way/123", crowd: 4, parking: "some", note: "  lot   full ", slot: "we:14" }, 1000, "abcdef0123");
  assert.deepStrictEqual(r, { beachId: "osm:way/123", slot: "we:14", report: { id: "abcdef0123", time: 1000, crowd: 4, parking: "some", note: "lot full" } });
  assert.match(parseReport({ beachId: "osm:way/1", crowd: 1, slot: "wd:9" }).report.id, /^[a-f0-9]{10}$/);
});

test("parseReport rejects bad input", () => {
  const ok = { beachId: "osm:node/1", crowd: 3, slot: "wd:9" };
  assert.throws(() => parseReport({ ...ok, beachId: "recent:x" }), /Unknown beach/);
  assert.throws(() => parseReport({ ...ok, crowd: 6 }), /1 to 5/);
  assert.throws(() => parseReport({ ...ok, crowd: 2.5 }), /1 to 5/);
  assert.throws(() => parseReport({ ...ok, parking: "lots" }), /parking/);
  assert.throws(() => parseReport({ ...ok, slot: "we:24" }), /slot/);
  assert.throws(() => parseReport(null), /Unknown beach/);
});

test("parseHistory groups sums and counts by slot", () => {
  assert.deepStrictEqual(parseHistory(["we:14:sum", "20", "we:14:n", "5", "wd:9:n", "2"]), {
    "we:14": { sum: 20, count: 5 },
    "wd:9": { sum: 0, count: 2 },
  });
  assert.deepStrictEqual(parseHistory(null), {});
});

test("without a store the API says it isn't configured", async () => {
  const res = fakeRes();
  await handler({ method: "GET", query: { ids: "osm:way/1" } }, res);
  assert.strictEqual(res.statusCode, 503);
});

test("GET returns recent reports with their votes, and history", async (t) => {
  const now = Date.now();
  fakeStore(t, (c) => {
    if (c[0] === "LRANGE") return [JSON.stringify({ id: "aaaaaaaaaa", time: now, crowd: 3 }), JSON.stringify({ time: now, crowd: 2 }), JSON.stringify({ time: now - 7 * 3600e3, crowd: 5 }), "junk"];
    if (c[1].startsWith("votes:")) return ["aaaaaaaaaa:up", "2", "aaaaaaaaaa:down", "1", "zzz:up", "4"];
    return ["we:14:sum", "8", "we:14:n", "2"];
  });
  const res = fakeRes();
  await handler({ method: "GET", query: { ids: "osm:way/1,bad id" } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.reports, { "osm:way/1": [{ id: "aaaaaaaaaa", time: now, crowd: 3, up: 2, down: 1 }, { time: now, crowd: 2 }] });
  assert.deepStrictEqual(res.body.history, { "osm:way/1": { "we:14": { sum: 8, count: 2 } } });
});

test("POST stores the report and updates history", async (t) => {
  const calls = fakeStore(t, (c) => (c[0] === "SET" ? "OK" : 1));
  const res = fakeRes();
  await handler({
    method: "POST",
    headers: { "x-forwarded-for": "1.2.3.4" },
    body: { beachId: "osm:way/1", crowd: 5, parking: "full", slot: "we:14" },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(calls[0][0], ["SET", "rl:1.2.3.4:osm:way/1", "1", "NX", "EX", 600]);
  const names = calls[1].map((c) => c[0]);
  assert.deepStrictEqual(names, ["LPUSH", "LTRIM", "EXPIRE", "HINCRBY", "HINCRBY", "SET"]);
  assert.match(calls[1][5][1], /^by:[a-f0-9]{10}$/);
  assert.deepStrictEqual(calls[1][3], ["HINCRBY", "hist:osm:way/1", "we:14:sum", 5]);
});

test("POST is rate limited per visitor and beach", async (t) => {
  const calls = fakeStore(t, () => null); // SET NX fails: already reported
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: { beachId: "osm:way/1", crowd: 2, slot: "wd:9" } }, res);
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(calls.length, 1);
});

test("POST rejects invalid reports before touching the store", async (t) => {
  const calls = fakeStore(t, () => "OK");
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: JSON.stringify({ beachId: "osm:way/1", crowd: 0, slot: "wd:9" }) }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(calls.length, 0);
});

// --- Alerts --------------------------------------------------------------

const alertsHandler = require("../api/alerts.js");

function pushEnv(t) {
  process.env.VAPID_PUBLIC_KEY = "pub";
  process.env.VAPID_PRIVATE_KEY = "priv";
  t.after(() => { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; });
}

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BNc", auth: "a2b" } };

test("alerts API needs both the store and push keys", async (t) => {
  fakeStore(t, () => "OK");
  const res = fakeRes();
  await alertsHandler({ method: "GET", headers: {} }, res);
  assert.strictEqual(res.statusCode, 503);
  pushEnv(t);
  const res2 = fakeRes();
  await alertsHandler({ method: "GET", headers: {} }, res2);
  assert.deepStrictEqual(res2.body, { publicKey: "pub" });
});

test("alert sign-up is stored per beach, keyed by endpoint", async (t) => {
  pushEnv(t);
  const calls = fakeStore(t, (c) => (c[0] === "INCR" ? 1 : c[0] === "HLEN" ? 0 : "OK"));
  const res = fakeRes();
  await alertsHandler({
    method: "POST",
    headers: { "x-forwarded-for": "1.2.3.4" },
    body: { beachId: "osm:way/1", name: "East Beach", level: 4, parking: true, link: "/?beach=x", subscription: SUB },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  const hset = calls[2][0];
  assert.deepStrictEqual(hset.slice(0, 3), ["HSET", "alerts:osm:way/1", alertsHandler.fieldFor(SUB.endpoint)]);
  assert.strictEqual(JSON.parse(hset[3]).level, 4);

  const bad = fakeRes();
  await alertsHandler({ method: "POST", headers: {}, body: { beachId: "osm:way/1", name: "x", level: 4, subscription: { endpoint: "https://example.com/x", keys: SUB.keys } } }, bad);
  assert.strictEqual(bad.statusCode, 400);
});

test("a report that makes the beach busy pushes to watchers once, and drops dead subscriptions", async (t) => {
  pushEnv(t);
  const now = Date.now();
  const watcher = (level, endpoint) => JSON.stringify({ sub: { ...SUB, endpoint }, level, parking: false, name: "East Beach", link: "/?beach=x" });
  const calls = fakeStore(t, (c) => {
    if (c[0] === "SET") return "OK";
    if (c[0] === "LRANGE") return [JSON.stringify({ time: now, crowd: 5 }), JSON.stringify({ time: now - 60e3, crowd: 4 })];
    if (c[0] === "HGETALL") return ["f1", watcher(4, "https://fcm.googleapis.com/1"), "f2", watcher(5, "https://fcm.googleapis.com/2"), "f3", "junk"];
    return 1;
  });
  const sent = [];
  t.mock.method(handler, "sendPush", async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload });
    return sub.endpoint.endsWith("/2") ? 410 : 201;
  });
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: { beachId: "osm:way/1", crowd: 5, slot: "we:14" } }, res);
  assert.strictEqual(res.statusCode, 200);
  // crowd ≈ 4.5 rounds to 5: both a "busy" and a "packed" watcher qualify.
  assert.deepStrictEqual(sent.map((s) => s.endpoint), ["https://fcm.googleapis.com/1", "https://fcm.googleapis.com/2"]);
  assert.match(sent[0].payload.title, /^East Beach is /);
  assert.strictEqual(sent[0].payload.url, "/?beach=x");
  const cooldowns = calls.find((cmds) => cmds[0][1] && String(cmds[0][1]).startsWith("alerted:"));
  assert.deepStrictEqual(cooldowns.map((c) => c[1]), ["alerted:osm:way/1:f1", "alerted:osm:way/1:f2"]);
  assert.deepStrictEqual(calls[calls.length - 1], [["HDEL", "alerts:osm:way/1", "f2"]]);
});

test("watchers alerted recently aren't alerted again, and push trouble never fails the report", async (t) => {
  pushEnv(t);
  const now = Date.now();
  let sets = 0;
  fakeStore(t, (c) => {
    if (c[0] === "SET") return sets++ === 0 ? "OK" : null; // rate limit passes, cooldown already taken
    if (c[0] === "LRANGE") return [JSON.stringify({ time: now, crowd: 5 })];
    if (c[0] === "HGETALL") return ["f1", JSON.stringify({ sub: SUB, level: 4, name: "East Beach" })];
    return 1;
  });
  const push = t.mock.method(handler, "sendPush", async () => { throw new Error("boom"); });
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: { beachId: "osm:way/1", crowd: 5, slot: "we:14" } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(push.mock.callCount(), 0);
});


// --- Votes ---------------------------------------------------------------

const votesHandler = require("../api/votes.js");
const { visitorKey } = require("../api/_store.js");

function voteStore(t, { author = "someone-else", fresh = "OK", count = 1, exists = true } = {}) {
  return fakeStore(t, (c) => {
    if (c[0] === "INCR") return count;
    if (c[0] === "LRANGE") return exists ? [JSON.stringify({ id: "abcdef0123", time: Date.now(), crowd: 4 })] : [];
    if (c[0] === "GET") return author;
    if (c[0] === "SET" && c[1].startsWith("voted:")) return fresh;
    if (c[0] === "HGETALL") return ["abcdef0123:up", "3", "abcdef0123:down", "1"];
    return "OK";
  });
}
const voteReq = (body, ip = "5.6.7.8") => ({ method: "POST", headers: { "x-forwarded-for": ip }, body });

test("a vote is counted once per visitor and returns the new totals", async (t) => {
  const calls = voteStore(t);
  const res = fakeRes();
  await votesHandler(voteReq({ beachId: "osm:way/1", reportId: "abcdef0123", vote: "up" }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, { up: 3, down: 1 });
  const write = calls[calls.length - 1];
  assert.deepStrictEqual(write[0], ["HINCRBY", "votes:osm:way/1", "abcdef0123:up", 1]);
  assert.deepStrictEqual(calls[1][0].slice(0, 4), ["SET", "voted:abcdef0123:" + visitorKey({ headers: { "x-forwarded-for": "5.6.7.8" } }), "1", "NX"]);
});

test("votes are refused twice, on your own report, on expired reports and when bad", async (t) => {
  const cases = [
    [{ fresh: null }, 409],
    [{ author: visitorKey({ headers: { "x-forwarded-for": "5.6.7.8" } }) }, 403],
    [{ exists: false }, 404],
    [{ count: 61 }, 429],
  ];
  for (const [opts, status] of cases) {
    await t.test(String(status), async (t2) => {
      voteStore(t2, opts);
      const res = fakeRes();
      await votesHandler(voteReq({ beachId: "osm:way/1", reportId: "abcdef0123", vote: "down" }), res);
      assert.strictEqual(res.statusCode, status);
    });
  }
  const calls = voteStore(t);
  for (const body of [{ beachId: "osm:way/1", reportId: "nope", vote: "up" }, { beachId: "osm:way/1", reportId: "abcdef0123", vote: "meh" }]) {
    const res = fakeRes();
    await votesHandler(voteReq(body), res);
    assert.strictEqual(res.statusCode, 400);
  }
  assert.strictEqual(calls.length, 0);
});
