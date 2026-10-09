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
  assert.deepStrictEqual(r, { beachId: "osm:way/123", slot: "we:14", report: { id: "abcdef0123", time: 1000, crowd: 4, parking: "some", note: "lot full" }, photo: null, reporter: null });
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

// --- Photos --------------------------------------------------------------

const photoHandler = require("../api/photo.js");
const { parsePhoto } = require("../api/_store.js");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]).toString("base64");

test("photos must be small JPEGs", () => {
  assert.strictEqual(parsePhoto(undefined), null);
  assert.strictEqual(parsePhoto(JPEG), JPEG);
  assert.throws(() => parsePhoto(Buffer.from("<svg onload=alert(1)>").toString("base64")), /not a photo/);
  assert.throws(() => parsePhoto(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500 * 1024)]).toString("base64")), /too big/);
  assert.throws(() => parsePhoto("not base64!"), /not a photo/);
  assert.throws(() => parsePhoto({}), /not a photo/);
});

test("a report with a photo stores it beside the report, for as long", async (t) => {
  const calls = fakeStore(t, (c) => (c[0] === "SET" ? "OK" : 1));
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: { beachId: "osm:way/1", crowd: 3, slot: "we:14", photo: JPEG } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.report.photo, true);
  const set = calls[1].find((c) => String(c[1]).startsWith("photo:"));
  assert.deepStrictEqual(set, ["SET", `photo:${res.body.report.id}`, JPEG, "EX", 6 * 60 * 60]);
  assert.ok(!JSON.parse(calls[1][0][2]).photoData); // the report itself stays small
});

test("photos are served until they expire or the report is flagged", async (t) => {
  let votes = [];
  fakeStore(t, (c) => (c[0] === "GET" ? (c[1] === "photo:abcdef0123" ? JPEG : null) : votes));
  const get = async (id) => {
    const res = fakeRes();
    res.send = function (b) { this.body = b; return this; };
    await photoHandler({ method: "GET", query: { beach: "osm:way/1", id } }, res);
    return res;
  };
  const ok = await get("abcdef0123");
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(ok.headers["Content-Type"], "image/jpeg");
  assert.strictEqual(ok.body[0], 0xff);
  assert.strictEqual((await get("0000000000")).statusCode, 404);
  assert.strictEqual((await get("../etc")).statusCode, 400);
  votes = ["abcdef0123:down", "3"];
  assert.strictEqual((await get("abcdef0123")).statusCode, 410);
});

// --- Points and the board ----------------------------------------------------

const leadersHandler = require("../api/leaders.js");
const { weekKey } = require("../js/points.js");
const ME = "0123456789abcdef";

test("a report with a reporter id earns 10 points and remembers who sent it", async (t) => {
  const calls = fakeStore(t, (c) => (c[0] === "SET" ? "OK" : 1));
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: { beachId: "osm:way/1", crowd: 3, slot: "we:14", reporter: ME } }, res);
  assert.strictEqual(res.statusCode, 200);
  const cmds = calls[1];
  const week = weekKey();
  assert.deepStrictEqual(cmds.find((c) => String(c[1]).startsWith("rep:")), ["SET", `rep:${res.body.report.id}`, ME, "EX", 6 * 60 * 60]);
  assert.deepStrictEqual(cmds.filter((c) => c[0] === "ZINCRBY"), [
    ["ZINCRBY", `board:${week}`, 10, ME],
    ["ZINCRBY", "board:all", 10, ME],
    ["ZINCRBY", `reports:${week}`, 1, ME],
  ]);
  assert.ok(!JSON.stringify(JSON.parse(cmds[0][2])).includes(ME)); // the stored report never carries the id
});

test("votes move the reporter's points", async (t) => {
  const calls = fakeStore(t, (c) => {
    if (c[0] === "INCR") return 1;
    if (c[0] === "LRANGE") return [JSON.stringify({ id: "abcdef0123", time: Date.now(), crowd: 4 })];
    if (c[0] === "GET") return c[1].startsWith("rep:") ? ME : "someone-else";
    if (c[0] === "HGETALL") return [];
    return "OK";
  });
  const res = fakeRes();
  await votesHandler(voteReq({ beachId: "osm:way/1", reportId: "abcdef0123", vote: "down" }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(calls[calls.length - 1].filter((c) => c[0] === "ZINCRBY"), [
    ["ZINCRBY", `board:${weekKey()}`, -2, ME],
    ["ZINCRBY", "board:all", -2, ME],
  ]);
});

test("the board shows names and points, never reporter ids", async (t) => {
  const OTHER = "fedcba9876543210";
  fakeStore(t, (c) => {
    if (c[0] === "ZREVRANGE") return [OTHER, "34", ME, "22"];
    if (c[0] === "HGET") return c[2] === OTHER ? "Sandy Toes" : null;
    if (c[0] === "ZSCORE") return c[1].startsWith("reports:") ? "3" : c[1] === "board:all" ? "120" : "22";
    if (c[0] === "ZREVRANK") return 1;
    return null;
  });
  const res = fakeRes();
  await leadersHandler({ method: "GET", query: { me: ME }, headers: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body.top, [
    { name: "Sandy Toes", points: 34, reports: 3 },
    { name: leadersHandler.defaultName(ME), points: 22, reports: 3, you: true },
  ]);
  assert.deepStrictEqual(res.body.me, { name: leadersHandler.defaultName(ME), named: false, points: 22, reports: 3, rank: 2, total: 120 });
  assert.match(leadersHandler.defaultName(ME), /^Beachgoer [0-9A-F]{4}$/);
  assert.ok(!JSON.stringify(res.body).includes(ME) && !JSON.stringify(res.body).includes(OTHER));
});

test("nicknames are checked and rate limited", async (t) => {
  const calls = fakeStore(t, (c) => (c[0] === "INCR" ? 1 : "OK"));
  const ok = fakeRes();
  await leadersHandler({ method: "POST", headers: {}, body: { reporter: ME, name: " Sandy  Toes " } }, ok);
  assert.deepStrictEqual(ok.body, { ok: true, name: "Sandy Toes" });
  assert.deepStrictEqual(calls[calls.length - 1], [["HSET", "names", ME, "Sandy Toes"]]);
  const bad = fakeRes();
  await leadersHandler({ method: "POST", headers: {}, body: { reporter: ME, name: "<b>" } }, bad);
  assert.strictEqual(bad.statusCode, 400);
  const noId = fakeRes();
  await leadersHandler({ method: "POST", headers: {}, body: { reporter: "x", name: "Sandy" } }, noId);
  assert.strictEqual(noId.statusCode, 400);
});
