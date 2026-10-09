// Reporter points: +10 a report, +2 for each upvote a report gets, -2 for each downvote. Points go on
// a weekly board (weeks start Monday, UTC) and a lifetime total. Shared by the page and api/.

const POINTS = { report: 10, up: 2, down: -2 };
const REPORTER_RE = /^[a-f0-9]{16}$/; // a device's private reporter id; never shown to others
const BOARD_SIZE = 10;

// "2026-W41": the ISO week of `ms`.
function weekKey(ms = Date.now()) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday - jan1) / (7 * 24 * 60 * 60 * 1000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// A nickname for the board: 2–20 letters, numbers, spaces and . _ ' -, or throws with a message.
function cleanName(text) {
  const name = String(text || "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 20) throw new Error("Pick a name of 2 to 20 characters.");
  if (!/^[\p{L}\p{N} ._'-]+$/u.test(name)) throw new Error("Names can use letters, numbers, spaces and . _ ' -");
  if (/^beachgoer\b/i.test(name)) throw new Error("Pick a name of your own.");
  return name;
}

if (typeof module !== "undefined") {
  module.exports = { POINTS, REPORTER_RE, BOARD_SIZE, weekKey, cleanName };
}
