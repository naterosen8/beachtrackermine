// Alert rules for "tell me when my beach gets busy", shared by the page and api/ (so the push the
// server sends and the alert the open page shows always agree). Pure functions, no DOM.

const CROWD = typeof crowdLabel === "function" ? { crowdLabel, PARKING_LABELS } : require("./crowd.js");

const ALERT_LEVELS = [4, 5]; // Busy, Packed
const ALERT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // at most one alert per beach every 3 hours

// Push services browsers use. Subscriptions anywhere else are refused, so the server only ever
// sends to real push services.
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
const B64URL_RE = /^[A-Za-z0-9_-]+=*$/;
const ID_RE = /^(osm:(node|way|relation)\/\d{1,15}|demo:[a-z0-9-]{1,40})$/;

// What to alert about, given the live status and someone's settings { level, parking }:
// { crowd: bool, parking: bool }, or null when there's nothing to say.
function alertReason(live, prefs) {
  if (!live || !prefs) return null;
  const crowd = Math.round(live.crowd) >= prefs.level;
  const parking = !!prefs.parking && live.parking === "full";
  return crowd || parking ? { crowd, parking } : null;
}

// Notification text, e.g. "Leadbetter Beach is Busy" / "2 beachgoers report it Busy · Parking full".
function alertMessage(name, live, reason) {
  const label = CROWD.crowdLabel(live.crowd);
  const title = reason.crowd ? `${name} is ${label.toLowerCase()}` : `Parking is full at ${name}`;
  const who = `${live.count} beachgoer${live.count > 1 ? "s" : ""}`;
  const bits = [`${who} report it ${label.toLowerCase()}`];
  if (live.parking) bits.push(CROWD.PARKING_LABELS[live.parking].toLowerCase());
  return { title, body: `${bits.join(" · ")}. Tap to see other beaches.` };
}

// A browser push subscription, checked: { endpoint, keys: { p256dh, auth } } at a real push service.
function parseSubscription(input) {
  const sub = input || {};
  let host;
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== "https:") throw new Error();
    host = url.hostname;
  } catch {
    throw new Error("Bad subscription");
  }
  if (String(sub.endpoint).length > 1000 || !PUSH_HOSTS.some((re) => re.test(host))) throw new Error("Bad subscription");
  const keys = sub.keys || {};
  for (const k of ["p256dh", "auth"]) {
    if (typeof keys[k] !== "string" || keys[k].length > 200 || !B64URL_RE.test(keys[k])) throw new Error("Bad subscription");
  }
  return { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// A path on this site for a notification to open; anything else becomes "/".
const sitePath = (link) => (typeof link === "string" && /^\/(?!\/)[^\s]{0,400}$/.test(link) ? link : "/");

// Checks an alert sign-up sent to api/alerts; returns it cleaned or throws with a message.
function parseAlertSignup(body) {
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.beachId !== "string" || !ID_RE.test(b.beachId)) throw new Error("Unknown beach");
  const sub = parseSubscription(b.subscription);
  const level = Number(b.level);
  if (!ALERT_LEVELS.includes(level)) throw new Error("Level must be 4 or 5");
  const name = typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  if (!name) throw new Error("Missing beach name");
  return {
    beachId: b.beachId,
    alert: {
      sub,
      level,
      parking: !!b.parking,
      name,
      link: sitePath(b.link),
    },
  };
}

if (typeof module !== "undefined") {
  module.exports = { ID_RE, ALERT_LEVELS, ALERT_COOLDOWN_MS, alertReason, alertMessage, parseSubscription, sitePath, parseAlertSignup };
}
