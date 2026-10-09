const test = require("node:test");
const assert = require("node:assert");
const { osmAmenity, osmAmenities, hasAmenity, amenityText } = require("../js/amenities.js");

test("recognizes amenities from OpenStreetMap tags", () => {
  assert.strictEqual(osmAmenity({ amenity: "toilets" }), "restrooms");
  assert.strictEqual(osmAmenity({ amenity: "fast_food", name: "Harbor Snack Shack" }), "food");
  assert.strictEqual(osmAmenity({ leisure: "firepit" }), "firepits");
  assert.strictEqual(osmAmenity({ leisure: "pitch", sport: "beachvolleyball" }), "volleyball");
  assert.strictEqual(osmAmenity({ amenity: "parking" }), null);
});

test("collects nearby amenities in a fixed order, naming places to eat", () => {
  const beach = { lat: 34.4096, lon: -119.6909 };
  const at = (dLat, tags) => ({ lat: beach.lat + dLat, lon: beach.lon, tags });
  const list = osmAmenities(beach, [
    at(0.001, { amenity: "restaurant", name: "Chad's" }),
    at(0.002, { amenity: "fast_food", name: "Harbor Snack Shack" }),
    at(0.0021, { amenity: "cafe", name: "Third" }),
    at(0.001, { amenity: "toilets" }),
    at(0.0012, { amenity: "toilets" }),
    at(0.01, { amenity: "shower" }), // 1.1 km away: too far
  ]);
  assert.deepStrictEqual(list, [{ key: "restrooms" }, { key: "food", note: "Chad's, Harbor Snack Shack" }]);
  assert.strictEqual(amenityText(list), "Restrooms · Food: Chad's, Harbor Snack Shack");
  assert.strictEqual(amenityText([{ key: "showers", note: "Cabrillo Pavilion" }]), "Showers (Cabrillo Pavilion)");
  assert.ok(hasAmenity({ amenities: list }, "food"));
  assert.ok(!hasAmenity({}, "food"));
});
