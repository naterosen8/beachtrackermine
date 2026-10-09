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

module.exports = { store, clientIp, readBody, pushKeys, sendPush };
