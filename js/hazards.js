// Official beach hazards from the National Weather Service (rip currents, high surf, coastal flooding,
// tsunami...), matched to each beach's NWS land forecast zone. Shared by the page and api/.
// Pure functions, no DOM, so they can be tested in Node.

// NWS alerts that matter on the beach.
const BEACH_EVENTS = [
  "Tsunami Warning", "Tsunami Advisory", "Tsunami Watch",
  "High Surf Warning", "High Surf Advisory",
  "Rip Current Statement", "Beach Hazards Statement",
  "Coastal Flood Warning", "Coastal Flood Advisory", "Coastal Flood Watch", "Coastal Flood Statement",
  "Sneaker Wave Statement",
];
const ZONE_RE = /^[A-Z]{2}Z\d{3}$/;

// How serious, for sorting and wording: warnings first.
const eventRank = (event) => (/Warning/.test(event) ? 3 : /Advisory|Watch/.test(event) ? 2 : 1);

// NWS /alerts/active GeoJSON -> beach alerts [{ id, event, headline, what, ends, instruction, zones }].
function parseNwsAlerts(json) {
  return ((json && json.features) || []).map((f) => {
    const p = f.properties || {};
    const what = /\* WHAT\.\.\.([\s\S]*?)(?:\n\s*\n|\n\*|$)/.exec(p.description || "");
    return {
      id: p.id,
      event: p.event,
      headline: p.headline || "",
      what: what ? what[1].replace(/\s+/g, " ").trim() : "",
      ends: Date.parse(p.ends || p.expires) || null,
      instruction: (p.instruction || "").replace(/\s+/g, " ").trim(),
      zones: (p.affectedZones || []).map((z) => String(z).split("/").pop()),
      status: p.status,
    };
  }).filter((a) => a.status === "Actual" && BEACH_EVENTS.includes(a.event) && (!a.ends || a.ends > Date.now() - 60 * 60 * 1000))
    .sort((a, b) => eventRank(b.event) - eventRank(a.event));
}

// Alerts covering a zone, one per kind of event (NWS sends updates as new alerts).
function alertsForZone(alerts, zone) {
  const seen = new Set();
  return (alerts || []).filter((a) => a.zones.includes(zone)).filter((a) => {
    if (seen.has(a.event)) return false;
    seen.add(a.event);
    return true;
  });
}

// A stable key for "this hazard at this beach", so the same alert (or its updates) is pushed once.
const hazardKey = (alert) => `${alert.event}|${alert.ends ? new Date(alert.ends).toISOString().slice(0, 13) : "open"}`;

if (typeof module !== "undefined") {
  module.exports = { BEACH_EVENTS, ZONE_RE, eventRank, parseNwsAlerts, alertsForZone, hazardKey };
}
