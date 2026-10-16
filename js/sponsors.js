// Local businesses that pay a monthly fee to advertise on Beach Check. The owner approves each one
// and adds it to SPONSORS; it shows until the end of its paidThrough day (Pacific time is close
// enough: the date is compared on the visitor's device) and then drops off by itself, so a lapsed
// payment never keeps an ad running.
//
//   { name: "IV Surf Co.", tagline: "Wetsuit rentals on Pardall", url: "https://example.com",
//     paidThrough: "2026-11-30", beaches: ["osm:way/551452844"] }
//
// beaches: ids of the beaches whose cards also show the ad (from js/santa-barbara.js); leave it out
// to show only in the sponsor spot above the list. Every ad is labeled "Sponsored".
// Pure functions, no DOM, so it can be tested in Node.

const SPONSORS = [];

// Filled in by the owner: how businesses sign up. Empty values hide that option on advertise.html.
const ADVERTISE = {
  email: "", // where businesses write to ask about advertising
  paymentLink: "", // a Stripe Payment Link for the monthly sponsorship
  monthlyPrice: "", // e.g. "$50/month", shown as written
};

// "2026-11-30" -> true while that day hasn't ended on this device.
function paidUp(paidThrough, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(paidThrough || ""));
  if (!m) return false;
  return now < new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime();
}

// Sponsors that are paid up and complete enough to show, with only https links.
function activeSponsors(list, now) {
  return (list || []).filter((s) => s && s.name && /^https:\/\//.test(s.url || "") && paidUp(s.paidThrough, now));
}

// Every sponsor gets a fair share of views: the spot rotates through them each hour.
function sponsorForSpot(list, now) {
  const active = activeSponsors(list, now);
  return active.length ? active[Math.floor(now / 3600000) % active.length] : null;
}

// The sponsor shown on one beach's card, if any paid for that beach (rotating by hour too).
function sponsorForBeach(list, beachId, now) {
  const mine = activeSponsors(list, now).filter((s) => Array.isArray(s.beaches) && s.beaches.includes(beachId));
  return mine.length ? mine[Math.floor(now / 3600000) % mine.length] : null;
}

if (typeof module !== "undefined") {
  module.exports = { SPONSORS, ADVERTISE, paidUp, activeSponsors, sponsorForSpot, sponsorForBeach };
}
