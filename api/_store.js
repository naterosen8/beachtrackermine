// Shared by the api/ functions (Vercel doesn't serve files starting with "_" as routes).

// Upstash Redis (or Vercel KV) over REST. Returns null when no store is configured; otherwise a
// function that runs several Redis commands in one request and returns their results in order.
function store() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return async (commands) => {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Store returned ${res.status}`);
    return (await res.json()).map((r) => {
      if (r.error) throw new Error(r.error);
      return r.result;
    });
  };
}

function clientIp(req) {
  const fwd = (req.headers && req.headers["x-forwarded-for"]) || "";
  return fwd.split(",")[0].trim() || "unknown";
}

// A visitor's address, hashed, for keys that only need to tell visitors apart.
const visitorKey = (req) => require("crypto").createHash("sha256").update(`beachcheck:${clientIp(req)}`).digest("hex").slice(0, 20);

const REPORT_ID_RE = /^[a-f0-9]{10}$/;
const newReportId = () => require("crypto").randomBytes(5).toString("hex");

// A report photo: base64 JPEG (re-encoded and shrunk by the page, so no location data) of at most
// MAX_PHOTO_BYTES. Returns the base64 text, null when there's no photo, or throws.
const MAX_PHOTO_BYTES = 400 * 1024;
function parsePhoto(photo) {
  if (photo == null || photo === "") return null;
  if (typeof photo !== "string" || photo.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(photo)) {
    throw new Error("Photo is too big or not a photo");
  }
  const bytes = Buffer.from(photo, "base64");
  if (bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("Photo is too big or not a photo");
  return photo;
}

// HGETALL of votes:<beachId> ("<reportId>:up" -> n) as { reportId: { up, down } }.
function parseVotes(flat) {
  const votes = {};
  for (let i = 0; i + 1 < (flat || []).length; i += 2) {
    const m = /^([a-f0-9]{10}):(up|down)$/.exec(flat[i]);
    if (!m) continue;
    (votes[m[1]] = votes[m[1]] || { up: 0, down: 0 })[m[2]] = Number(flat[i + 1]) || 0;
  }
  return votes;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body);
  return {};
}

// Web push keys (VAPID). Generate a pair once with `npx web-push generate-vapid-keys`.
function pushKeys(req) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  const host = (req && req.headers && req.headers.host) || "localhost";
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT || `https://${host}` };
}

// Sends one web push; resolves to the push service's status code (404/410 mean the
// subscription is gone).
async function sendPush(sub, payload, keys) {
  const webpush = require("web-push");
  try {
    const res = await webpush.sendNotification(sub, JSON.stringify(payload), {
      vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: 60 * 60,
      urgency: "high",
    });
    return res.statusCode;
  } catch (err) {
    return err.statusCode || 0;
  }
}

// Adds points to a reporter's weekly and lifetime totals (Redis commands to run in a pipeline).
const BOARD_KEEP_SECONDS = 15 * 24 * 60 * 60;
function awardPoints(reporter, points, { report = false, now = Date.now() } = {}) {
  const { weekKey } = require("../js/points.js");
  const week = weekKey(now);
  const cmds = [
    ["ZINCRBY", `board:${week}`, points, reporter],
    ["EXPIRE", `board:${week}`, BOARD_KEEP_SECONDS],
    ["ZINCRBY", "board:all", points, reporter],
  ];
  if (report) cmds.push(["ZINCRBY", `reports:${week}`, 1, reporter], ["EXPIRE", `reports:${week}`, BOARD_KEEP_SECONDS]);
  return cmds;
}

module.exports = { awardPoints, store, clientIp, visitorKey, readBody, pushKeys, sendPush, REPORT_ID_RE, newReportId, parseVotes, parsePhoto };
