// Beach amenities: restrooms, showers, food, grills, fire rings... For hand-checked beaches they come
// from js/santa-barbara.js (official park pages); elsewhere from OpenStreetMap features near the beach.
// Pure functions, no DOM, so it can be tested in Node.

const AMENITIES = {
  restrooms: "Restrooms",
  showers: "Showers",
  water: "Drinking water",
  food: "Food",
  bbq: "BBQ grills",
  firepits: "Fire rings",
  picnic: "Picnic tables",
  playground: "Playground",
  volleyball: "Volleyball",
  wheelchairs: "Beach wheelchairs",
};
const AMENITY_NEAR_KM = 0.4; // from the beach's middle; long beaches have facilities along them

// Which amenity an OpenStreetMap feature is, by its tags; null if none we show.
function osmAmenity(tags) {
  const a = tags.amenity;
  const l = tags.leisure;
  if (a === "toilets") return "restrooms";
  if (a === "shower") return "showers";
  if (a === "drinking_water") return "water";
  if (["restaurant", "cafe", "fast_food", "ice_cream"].includes(a)) return "food";
  if (a === "bbq") return "bbq";
  if (l === "firepit") return "firepits";
  if (a === "picnic_table" || l === "picnic_table") return "picnic";
  if (l === "playground") return "playground";
  if (tags.sport === "beachvolleyball" || (l === "pitch" && /volleyball/.test(tags.sport || ""))) return "volleyball";
  return null;
}

// Amenities for a beach from features [{ lat, lon, tags }] within AMENITY_NEAR_KM, in display order:
// [{ key, note? }], naming up to two places to eat.
function osmAmenities(beach, features, near = typeof distanceKm === "function" ? distanceKm : require("./crowd.js").distanceKm) {
  const found = new Map();
  for (const f of features) {
    const key = osmAmenity(f.tags || {});
    if (!key || near(beach, f) > AMENITY_NEAR_KM) continue;
    const entry = found.get(key) || { key, names: [] };
    if (key === "food" && f.tags.name && !entry.names.includes(f.tags.name)) entry.names.push(f.tags.name);
    found.set(key, entry);
  }
  return Object.keys(AMENITIES).filter((k) => found.has(k)).map((key) => {
    const { names } = found.get(key);
    return names.length ? { key, note: names.slice(0, 2).join(", ") } : { key };
  });
}

const hasAmenity = (beach, key) => (beach.amenities || []).some((a) => a.key === key);

// "Restrooms · Showers (Cabrillo Pavilion) · Food: Boathouse"
function amenityText(list) {
  return list.map(({ key, note }) => (note ? `${AMENITIES[key]}${key === "food" ? ": " : " ("}${note}${key === "food" ? "" : ")"}` : AMENITIES[key])).join(" · ");
}

if (typeof module !== "undefined") {
  module.exports = { AMENITY_NEAR_KM, AMENITIES, osmAmenity, osmAmenities, hasAmenity, amenityText };
}
