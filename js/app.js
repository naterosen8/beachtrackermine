// Wires location search, beach data, crowd estimates, the map and report forms together.

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 2 * 60 * 1000;
const NEAR_BEACH_KM = 2; // reports only count from people at (or right next to) the beach
const imperial = /^en-(US|LR)|^my\b/.test(navigator.language || "");
const params = new URLSearchParams(location.search);
const demo = params.has("demo");
const FAVORITES_KEY = "beachcheck.favorites";
const PLACE_KEY = "beachcheck.place";
const ALERTS_KEY = "beachcheck.alerts"; // { beachId: { name, level, parking, push } }
const VOTES_KEY = "beachcheck.votes"; // { reportId: "up"|"down" } votes from this device
const MINE_KEY = "beachcheck.mine"; // ids of reports sent from this device
const ALERTED_KEY = "beachcheck.alerted";
const FAV_INFO_KEY = "beachcheck.favinfo"; // { beachId: { id, name, lat, lon, waterSites? } } for the morning summary
const MORNING_KEY = "beachcheck.morning"; // true once the morning summary is on
const REPORTER_KEY = "beachcheck.reporter"; // this device's private reporter id, for points // { beachId: time of the last alert this page showed }
const BUSY = 3.5; // the forecast counts as "busy" from here
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const state = {
  center: null, // { lat, lon, label }
  beaches: [],
  weather: null,
  reports: {},
  history: {},
  shared: true,
  meters: {}, // live LA street-meter counts by beach id
  marine: {}, // hourly waves, water temperature and tide by beach id
  water: [], // county water quality sampling sites
  drives: {}, // road drive times from the searched place, by beach id
  amenities: {}, // OpenStreetMap amenities for beaches without a hand-checked list
  updated: null, // when live reports were last fetched
  favorites: new Set(load_(FAVORITES_KEY) || []),
  favInfo: load_(FAV_INFO_KEY) || {},
  alerts: load_(ALERTS_KEY) || {},
  myVotes: load_(VOTES_KEY) || {},
  mine: new Set(load_(MINE_KEY) || []),
  openLists: new Map(), // beachId -> whether its report list is open, once someone toggles it
};
let focusId = params.get("beach"); // a shared link points at this beach
let highlight = null; // { id, until }: the card picked last, outlined for a few seconds
let map = null;
let markers = null;

// --- Formatting ------------------------------------------------------------

const fmtDistance = (km) =>
  imperial ? `${(km * 0.621371).toFixed(km < 16 ? 1 : 0)} mi` : `${km.toFixed(km < 10 ? 1 : 0)} km`;
const fmtTemp = (c) => (imperial ? `${Math.round(c * 1.8 + 32)}°F` : `${Math.round(c)}°C`);
const fmtHeight = (m) => (imperial ? `${(m * 3.28084).toFixed(1)} ft` : `${m.toFixed(1)} m`);
const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

// A time on the chosen day, or with the weekday when it falls on another day.
function fmtClockOn(ms, day) {
  if (sameDay(ms, day)) return fmtClock(ms);
  return `${new Date(ms).toLocaleDateString([], { weekday: "short" })} ${fmtClock(ms)}`;
}

// This device's saved settings. Storage can be blocked (private mode), so failures are ignored.
function load_(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function save_(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not remembered, but everything still works
  }
}

function ago(time) {
  const min = Math.round((Date.now() - time) / 60000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// --- Planning ------------------------------------------------------------

// The day and time menus: today plus the next six days (as far as the forecasts go), and the
// hours the beach is worth visiting. "Now" only makes sense today.
function fillPlanMenus() {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const name = i === 0 ? "today" : i === 1 ? "tomorrow" : d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    days.push(new Option(name, String(i)));
  }
  $("day").replaceChildren(...days);
  const times = [new Option("now", "now")];
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) times.push(new Option(`at ${hourText(h)}`, String(h)));
  $("time").replaceChildren(...times);
}

function syncTimeMenu() {
  const today = $("day").value === "0";
  $("time").options[0].disabled = !today;
  if (!today && $("time").value === "now") $("time").value = "10";
}

// The time the person plans to arrive, from the "Going" menus.
function targetTime() {
  if ($("time").value === "now") return new Date();
  const d = new Date();
  d.setDate(d.getDate() + Number($("day").value));
  d.setHours(Number($("time").value), 0, 0, 0);
  return d;
}

// Sets the menus to a given time (from tapping an hour in a beach's forecast).
function planFor(time) {
  const d = new Date(time);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  $("day").value = String(Math.round((new Date(d).setHours(0, 0, 0, 0) - start) / DAY_MS));
  $("time").value = String(d.getHours());
  syncTimeMenu();
  render();
}

const FILTERS = ["f-fav", "f-guard", "f-dogs", "f-free", "f-water", "f-restrooms", "f-showers", "f-food", "f-firepits"];
const AMENITY_FILTERS = { "f-restrooms": "restrooms", "f-showers": "showers", "f-food": "food", "f-firepits": "firepits" };

// A beach's amenities: hand-checked, or from the map once they've loaded (null until then).
const amenitiesOf = (b) => b.amenities || state.amenities[b.id] || null;

// Beach features the filter chips look for.
const hasLifeguards = (b) => b.lifeguard === "yes" || !!b.lifeguards;
const dogFriendly = (b) => b.dogs === "yes" || b.dogs === "leashed" || !!b.dogArea;
const waterWarning = (b) => ["warning", "closed"].includes(worstWater(waterFor(b, state.water)));
const freeParking = (b) => (b.lots ? b.lots.some((l) => l.fee === "free") : !!b.freeParking);

function filtered(beaches) {
  return beaches.filter((b) =>
    (!$("f-fav").checked || state.favorites.has(b.id)) &&
    (!$("f-guard").checked || hasLifeguards(b)) &&
    (!$("f-dogs").checked || dogFriendly(b)) &&
    (!$("f-free").checked || freeParking(b)) &&
    (!$("f-water").checked || !waterWarning(b)) &&
    Object.entries(AMENITY_FILTERS).every(([id, key]) => !$(id).checked || (amenitiesOf(b) || []).some((a) => a.key === key)));
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  save_(FAVORITES_KEY, [...state.favorites]);
  render();
  syncMorning();
}

// What the morning summary needs about each starred beach, kept for beaches seen on the list.
function rememberFavorites() {
  let changed = false;
  for (const b of state.beaches) {
    if (!state.favorites.has(b.id)) continue;
    const info = { id: b.id, name: b.name, lat: b.lat, lon: b.lon };
    if (b.waterSites) info.waterSites = b.waterSites;
    if (JSON.stringify(state.favInfo[b.id]) !== JSON.stringify(info)) {
      state.favInfo[b.id] = info;
      changed = true;
    }
  }
  for (const id of Object.keys(state.favInfo)) {
    if (!state.favorites.has(id)) {
      delete state.favInfo[id];
      changed = true;
    }
  }
  if (changed) save_(FAV_INFO_KEY, state.favInfo);
}

const starredBeaches = () => [...state.favorites].map((id) => state.favInfo[id]).filter(Boolean).slice(0, 10);

// Signs up for (or updates) the morning summary of the starred beaches. `quiet` skips the first push.
async function sendMorning(quiet) {
  const sub = await pushSubscription();
  if (!sub) throw new Error(demo ? "Morning summaries need the real site." : "Morning summaries aren't set up on this site yet.");
  const res = await fetch("api/morning", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subscription: sub.toJSON(),
      beaches: starredBeaches(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      link: "/",
      quiet,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error === "not-configured" ? "Morning summaries aren't set up on this site yet." : json.error || "Couldn't turn on the morning summary.");
  return json;
}

async function stopMorning() {
  const reg = "serviceWorker" in navigator && (await navigator.serviceWorker.getRegistration());
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) {
    await fetch("api/morning", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
  }
}

// After the starred beaches change, update the summary quietly (or stop it when none are left).
let morningTimer = null;
function syncMorning() {
  if (!load_(MORNING_KEY)) return;
  clearTimeout(morningTimer);
  morningTimer = setTimeout(() => {
    rememberFavorites();
    if (!starredBeaches().length) {
      save_(MORNING_KEY, false);
      stopMorning();
      showMorning();
      return;
    }
    sendMorning(true).catch(() => {});
  }, 1500);
}

function showMorning() {
  const on = !!load_(MORNING_KEY);
  const button = $("morning-toggle");
  button.textContent = `☀️ Morning summary: ${on ? "on" : "off"}`;
  button.setAttribute("aria-pressed", String(on));
  button.classList.toggle("on", on);
}

$("morning-toggle").addEventListener("click", async () => {
  const button = $("morning-toggle");
  const msg = $("morning-msg");
  button.disabled = true;
  try {
    if (load_(MORNING_KEY)) {
      save_(MORNING_KEY, false);
      await stopMorning();
      msg.textContent = "Morning summary off.";
    } else {
      rememberFavorites();
      msg.textContent = "Turning on…";
      const { preview } = await sendMorning(false);
      save_(MORNING_KEY, true);
      msg.textContent = `On. Each morning around 8 you'll get a summary of your starred beaches. Today: ${preview.body.split("\n")[0]}`;
    }
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    button.disabled = false;
    showMorning();
  }
});

// Everything we know about one beach for the chosen arrival time.
function describe(beach, when) {
  const goingNow = Math.abs(when - Date.now()) < HOUR_MS / 2;
  const live = liveStatus(state.reports[beach.id] || []);
  const weather = state.weather ? weatherAt(state.weather, when.getTime()) : null;
  const est = estimateCrowd({ date: when, lat: beach.lat, weather, history: state.history[beach.id] });
  const useLive = live && goingNow;
  const crowd = useLive ? live.crowd : est.crowd;

  let parking;
  if (useLive && live.parking) {
    parking = { text: `${PARKING_LABELS[live.parking]} (reported)`, score: { plenty: 3, some: 2, full: 0 }[live.parking] };
  } else if (beach.curated) {
    const street = beach.lots.every((l) => l.street);
    const roomy = beach.parkingSpaces >= 200 || beach.lots.some((l) => l.fee === "free" && !l.street);
    parking = {
      text: `${sbParkingSummary(beach)}${crowd >= 4 ? " (busy: may fill up)" : ""}`,
      score: (street ? 1 : roomy ? 2.5 : 2) - (crowd >= 4 ? 1 : 0),
    };
  } else if (beach.parkingLots) {
    const lots = `${beach.parkingLots} lot${beach.parkingLots > 1 ? "s" : ""} nearby${beach.paidParking ? " (some paid)" : ""}`;
    parking = crowd >= 4
      ? { text: `${lots}, likely filling up`, score: 1 }
      : { text: `${lots}, probably spaces`, score: 2 };
  } else if (beach.parkingLots === 0) {
    parking = { text: "No mapped parking nearby: expect street parking", score: 0.5 };
  } else {
    parking = { text: "No parking info yet: be the first to report it", score: 1 };
  }

  // Live city sensor counts are about right now, so they only steer the pick when going now.
  const meters = state.meters[beach.id];
  if (meters && goingNow && !(useLive && live.parking)) {
    const share = meters.free / meters.total;
    parking = { ...parking, score: share >= 0.3 ? 3 : share >= 0.1 ? 2 : 0.5 };
  }

  const drive = driveFor(beach);
  const marineHours = state.marine[beach.id];
  const sea = marineAt(marineHours, when.getTime());
  const tide = marineHours ? tideAt(marineHours, when.getTime()) : null;
  const sun = sunTimes(when, beach.lat, beach.lon);
  const water = waterFor(beach, state.water);
  const waterLevel = worstWater(water);
  const day = dayForecast({
    day: when,
    lat: beach.lat,
    weatherFor: state.weather ? (t) => weatherAt(state.weather, t) : null,
    history: state.history[beach.id],
  });

  return {
    beach,
    drive,
    water,
    waterLevel,
    sea,
    tide,
    sun,
    day,
    meters,
    live,
    useLive,
    crowd,
    est,
    weather,
    parking,
    // Lower is better: quieter, closer, easier to park.
    // A water quality warning or closure pushes the beach well down the best picks.
    score: crowd + drive.minutes / 15 + (3 - parking.score) * 0.5 + (waterLevel === "closed" ? 3 : waterLevel === "warning" ? 1.5 : 0),
  };
}

// Minutes of driving: by road when the router answered, else estimated from the straight line.
const driveFor = (beach) => state.drives[beach.id] || { minutes: driveMinutes(beach.distanceKm), km: null, estimate: true };

const SORTS = {
  best: (a, b) => a.score - b.score,
  distance: (a, b) => a.drive.minutes - b.drive.minutes || a.beach.distanceKm - b.beach.distanceKm,
  quiet: (a, b) => a.crowd - b.crowd || a.beach.distanceKm - b.beach.distanceKm,
  parking: (a, b) => b.parking.score - a.parking.score || a.beach.distanceKm - b.beach.distanceKm,
};

// --- Rendering -------------------------------------------------------------

function render() {
  const when = targetTime();
  const shown = filtered(state.beaches);
  const views = shown.map((b) => describe(b, when)).sort(SORTS[$("sort").value]);
  const list = $("beaches");
  const openForm = list.querySelector(".report:not([hidden])");
  const openId = openForm && openForm.closest(".card").dataset.id;
  const openAlert = list.querySelector(".alert-form:not([hidden])");
  const openAlertId = openAlert && openAlert.closest(".card").dataset.id;
  list.replaceChildren(...views.map((v) => card(v, v.beach.id === openId, when, v.beach.id === openAlertId)));
  if ($("sort").value === "best" && views.length > 1 && list.firstElementChild) list.firstElementChild.classList.add("best");
  $("list-title").textContent = state.center ? `Beaches near ${state.center.label === "you" ? "you" : state.center.label.split(",")[0]}` : "Beaches";
  nowPanel();
  if (state.beaches.length && !shown.length) {
    list.append(el("li", $("f-fav").checked && !state.favorites.size
      ? "Tap ☆ on a beach to add it to your beaches."
      : "No beaches here match those filters.", "empty"));
  }
  drawMap(views);
  $("shared-note").hidden = state.shared || demo;
  $("refresh").hidden = !state.beaches.length;
  headsUp();
  showFocus();
}

// "Your beaches today": for each starred beach on the list, what beachgoers say now, or when
// it's expected to be busy today.
function headsUp() {
  rememberFavorites();
  showMorning();
  const mine = state.beaches.filter((b) => state.favorites.has(b.id));
  $("heads-up").hidden = !mine.length;
  if (!mine.length) return;
  const today = new Date();
  const items = mine.map((b) => {
    const live = liveStatus(state.reports[b.id] || []);
    let text;
    if (live) {
      text = `${crowdLabel(live.crowd)} right now (${live.count} live report${live.count > 1 ? "s" : ""})` +
        (live.parking === "full" ? " · parking full" : "");
    } else {
      const day = dayForecast({
        day: today,
        lat: b.lat,
        weatherFor: state.weather ? (t) => weatherAt(state.weather, t) : null,
        history: state.history[b.id],
      });
      const busy = day.filter((h) => h.crowd >= BUSY);
      text = busy.length
        ? `Expected busy ${rangeText(busy[0].hour, busy[busy.length - 1].hour + 1)}`
        : "Not expected to get busy today";
    }
    const li = el("li", null, live && Math.round(live.crowd) >= 4 ? "busy" : "");
    const link = el("a", b.name);
    link.href = `#${encodeURIComponent(b.id)}`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (filtered([b]).length === 0) for (const id of FILTERS) $(id).checked = false;
      focusId = b.id;
      render();
    });
    li.append(link, document.createTextNode(`: ${text}`));
    const wl = worstWater(waterFor(b, state.water));
    if (wl === "warning" || wl === "closed") li.append(el("span", ` · water ${wl === "closed" ? "closed" : "quality warning"}`, "water-warning"));
    if (state.alerts[b.id]) li.append(el("span", " 🔔", "bell"));
    return li;
  });
  $("heads-up").querySelector("ul").replaceChildren(...items);
}

// After opening a shared link, scroll to and highlight that beach once.
function showFocus() {
  if (!focusId) return;
  const target = document.querySelector(`.card[data-id="${CSS.escape(focusId)}"]`);
  if (!target) return;
  focusId = null;
  highlight = { id: target.dataset.id, until: Date.now() + 5000 }; // survives the next few re-renders
  target.classList.add("focus");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
}

function card(v, reportOpen, when, alertOpen) {
  const { beach, meters, live, useLive, crowd, est, weather, parking, sea, tide, sun, day, water, drive } = v;
  const node = $("beach-card").content.firstElementChild.cloneNode(true);
  const level = Math.min(5, Math.max(1, Math.round(crowd)));
  node.dataset.id = beach.id;
  node.classList.add(`level-${level}`);
  if (highlight && highlight.id === beach.id && Date.now() < highlight.until) node.classList.add("focus");
  node.querySelector(".name").textContent = beach.name;
  node.querySelector(".away").textContent = drive.estimate
    ? `${fmtDistance(beach.distanceKm)} · ~${drive.minutes} min drive`
    : `${fmtDistance(drive.km != null ? drive.km : beach.distanceKm)} by road · ${drive.minutes} min drive`;
  node.querySelector(".crowd-label").textContent = crowdLabel(crowd);
  node.querySelector(".crowd").prepend(gauge(crowd));
  node.querySelector(".meter").dataset.level = level;
  const fav = node.querySelector(".fav");
  const saved = state.favorites.has(beach.id);
  fav.replaceChildren(icon(saved ? "starFilled" : "star"));
  fav.setAttribute("aria-pressed", String(saved));
  fav.setAttribute("aria-label", saved ? `Remove ${beach.name} from my beaches` : `Save ${beach.name} to my beaches`);
  fav.title = saved ? "Saved to my beaches" : "Save to my beaches";
  fav.addEventListener("click", () => toggleFavorite(beach.id));
  const tag = node.querySelector(".tag");
  tag.textContent = useLive ? "Live" : "Estimate";
  tag.classList.add(useLive ? "tag-live" : "tag-est");

  node.querySelector(".basis").textContent = useLive
    ? `${live.count} report${live.count > 1 ? "s" : ""} from beachgoers, newest ${ago(live.newest)}`
    : `No live reports${live && !useLive ? " for then" : ""}. Based on: ${est.reasons.join(" · ")}`;

  const leaveRow = node.querySelector(".leave-row");
  for (const line of leaveLines(drive, when, day)) {
    const row = el("p", null, line.className);
    row.append(icon(line.classList.contains("beat") ? "sparkle" : "car"), document.createTextNode(line.textContent));
    leaveRow.append(row);
  }
  cardAlerts(node.querySelector(".card-alerts"), v);
  statTiles(node.querySelector(".stats"), v, when);

  const facts = node.querySelector(".facts");
  facts.append(el("li", `Parking: ${parking.text}`));
  if (meters) {
    facts.append(el("li", `Street meters within ${imperial ? "½ mile" : "800 m"}: ${meters.free} of ${meters.total} free right now ` +
      `(City of LA sensors, updated ${ago(meters.newest)})`));
  }
  if (live && !useLive) facts.append(el("li", `Right now: ${crowdLabel(live.crowd)} (${live.count} live report${live.count > 1 ? "s" : ""})`));
  if (weather) {
    const bits = [fmtTemp(weather.tempC), `${Math.round(weather.precipProb || 0)}% rain`];
    if (weather.uv != null) bits.push(`UV ${Math.round(weather.uv)}`);
    facts.append(el("li", `Weather then: ${bits.join(", ")}`));
  }
  for (const line of waterLines(water)) facts.append(line);
  if (sea && sea.waveM != null) {
    const period = sea.periodS ? `, ${Math.round(sea.periodS)} s apart` : "";
    facts.append(el("li", `Surf: ${surfLabel(sea.waveM)} (${fmtHeight(sea.waveM)}${period})`));
  }
  if (sea && sea.waterC != null) facts.append(el("li", `Water: about ${fmtTemp(sea.waterC)}`));
  if (tide) {
    // Model heights are from mean sea level, not the tide-table zero, so only times are shown.
    const turn = (t) => `${t.type} ${fmtClockOn(t.time, when)}`;
    facts.append(el("li", `Tide: ${tide.rising ? "rising" : "falling"}, ${turn(tide.next)}${tide.after ? `, then ${turn(tide.after)}` : ""}`));
  }
  if (sun) {
    const dark = when.getTime() > sun.sunset || when.getTime() < sun.sunrise;
    facts.append(el("li", `${dark ? "Dark then: " : ""}Sunrise ${fmtClock(sun.sunrise)}, sunset ${fmtClock(sun.sunset)}`));
  }
  if (beach.lifeguards === "seasonal") facts.append(el("li", "Seasonal lifeguards"));
  else if (beach.lifeguard === "yes") facts.append(el("li", "Lifeguarded"));
  if (beach.dogArea) facts.append(el("li", "Has a dog area"));
  if (beach.noDogsOnBeach) facts.append(el("li", "No dogs on the beach"));
  if (beach.dogs === "yes" || beach.dogs === "leashed") facts.append(el("li", "Dogs allowed"));

  const amenities = amenitiesOf(beach);
  if (amenities) {
    facts.append(el("li", amenities.length
      ? `Amenities: ${amenityText(amenities)}${beach.amenities ? "" : " (from OpenStreetMap)"}`
      : beach.amenities ? "No facilities: bring what you need" : "No amenities mapped nearby"));
  }
  if (beach.cams && beach.cams.length) facts.append(camLine(beach.cams));
  if (beach.curated) node.querySelector(".facts").after(lotList(beach));

  reportList(node, beach);

  const dest = `${beach.lat},${beach.lon}`;
  node.querySelector(".directions").href =
    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;

  dayBars(node, day, when);
  node.querySelector(".share").addEventListener("click", (e) => shareBeach(beach, e.currentTarget));
  buildReportForm(node, beach, reportOpen);
  buildAlertForm(node, beach, alertOpen);
  return node;
}

// A ring that fills with the crowd level (1–5), number in the middle.
function gauge(crowd) {
  const level = Math.min(5, Math.max(1, Math.round(crowd)));
  const wrap = el("span", null, "gauge");
  wrap.setAttribute("aria-hidden", "true");
  const pct = Math.round((Math.min(5, Math.max(1, crowd)) / 5) * 100);
  wrap.innerHTML = `<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5" pathLength="100" class="g-bg"/><circle cx="18" cy="18" r="15.5" pathLength="100" class="g-fg" stroke-dasharray="${pct} 100"/></svg><b>${level}</b>`;
  return wrap;
}

// "Right now" in the hero: the three best picks for going now, plus a few live numbers.
function nowPanel() {
  const list = $("now-list");
  if (!state.beaches.length) return;
  const now = new Date();
  const views = state.beaches.map((b) => describe(b, now)).sort(SORTS.best);
  list.replaceChildren(...views.slice(0, 3).map((v, i) => {
    const level = Math.min(5, Math.max(1, Math.round(v.crowd)));
    const li = el("li", null, `level-${level}`);
    const b = el("button", null, "now-item");
    b.type = "button";
    const name = el("span", null, "now-name");
    name.append(el("strong", v.beach.name), el("span", `${v.drive.minutes} min drive${i === 0 ? " · best pick" : ""}`));
    b.append(el("span", String(i + 1), "now-rank"), name, el("span", `${crowdLabel(v.crowd)}${v.useLive ? " · live" : ""}`, "now-badge"));
    b.addEventListener("click", () => {
      for (const id of FILTERS) $(id).checked = false;
      focusId = v.beach.id;
      render();
    });
    li.append(b);
    return li;
  }));
  const live = views.reduce((n, v) => n + (v.live ? v.live.count : 0), 0);
  const warnings = views.filter((v) => v.waterLevel === "warning" || v.waterLevel === "closed").length;
  const stats = [[String(state.beaches.length), "beaches"], [String(live), live === 1 ? "live report" : "live reports"], [String(warnings), warnings === 1 ? "water warning" : "water warnings"]];
  $("now-stats").replaceChildren(...stats.flatMap(([n, label]) => {
    const d = el("div");
    d.append(el("dt", label), el("dd", n));
    return [d];
  }));
  $("now-time").textContent = `Updated ${fmtClock(Date.now())}`;
}

// --- Card pieces: icons, stat tiles, warnings ------------------------------------

// Simple line icons (24×24, drawn with the current text color).
const ICONS = {
  car: '<path d="M5 17h14M6 17l1.5-5h9L18 17M7.5 12 9 8h6l1.5 4"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  parking: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"/>',
  drop: '<path d="M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  waves: '<path d="M2 9c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2M2 15c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2"/>',
  thermo: '<path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z"/>',
  tide: '<path d="M3 17c3 0 3-2 6-2s3 2 6 2 3-2 6-2M12 3v9M8.5 8.5 12 12l3.5-3.5"/>',
  sunset: '<path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 4v4M5 9l1.5 1.5M19 9l-1.5 1.5M9 6l3-2 3 2"/>',
  alert: '<path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  starFilled: '<path fill="currentColor" d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
};

function icon(name) {
  const span = el("span", null, "icon");
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`; // fixed strings above, never user data
  return span;
}

// The key facts as small labelled tiles: parking, water quality, weather, surf, water, tide, sunset.
function statTiles(box, v, when) {
  const { parking, waterLevel, weather, sea, tide, sun } = v;
  const tile = (name, label, value, note, tone) => {
    const t = el("div", null, `stat${tone ? ` stat-${tone}` : ""}`);
    const top = el("span", null, "stat-label");
    top.append(icon(name), document.createTextNode(label));
    t.append(top, el("strong", value, "stat-value"));
    if (note) t.append(el("span", note, "stat-note"));
    box.append(t);
  };
  const [lots, ...fees] = parking.text.split(" · ");
  tile("parking", "Parking", lots, fees.join(" · "), parking.score <= 0.5 ? "warn" : null);
  if (waterLevel !== "unknown") {
    tile("drop", "Water quality", { open: "Clean", warning: "Warning", closed: "Closed" }[waterLevel] || "Unknown",
      waterLevel === "open" ? "Meets health standards" : "County advises no swimming", waterLevel === "open" ? "ok" : "bad");
  }
  if (weather) tile("sun", "Weather", fmtTemp(weather.tempC), `${Math.round(weather.precipProb || 0)}% rain${weather.uv != null ? ` · UV ${Math.round(weather.uv)}` : ""}`);
  if (sea && sea.waveM != null) tile("waves", "Surf", fmtHeight(sea.waveM), surfLabel(sea.waveM));
  if (sea && sea.waterC != null) tile("thermo", "Water temp", fmtTemp(sea.waterC), "approx.");
  if (tide) tile("tide", "Tide", tide.rising ? "Rising" : "Falling", `${tide.next.type} ${fmtClockOn(tide.next.time, when)}`);
  if (sun) tile("sunset", "Sunset", fmtClock(sun.sunset), `Sunrise ${fmtClock(sun.sunrise)}`);
}

// A banner on the card when the county warns about the water, or after heavy rain.
function cardAlerts(box, v) {
  const banner = (text) => {
    const p = el("p", null, "card-alert");
    p.append(icon("alert"), document.createTextNode(text));
    box.append(p);
  };
  if (v.waterLevel === "closed") banner("Closed to swimming by the county.");
  else if (v.waterLevel === "warning") banner("Water quality warning: bacteria above state standards.");
  const rain = state.weather ? recentRainMm(state.weather) : 0;
  if (rain >= RAIN_ADVISORY_MM) banner("Rain advisory: stay out of the ocean for 72 hours after significant rain.");
}

// --- Recent reports and votes -------------------------------------------------

// Each report from the last few hours, with 👍/👎 so beachgoers can confirm or flag it.
function reportList(node, beach) {
  const reports = recentReports(state.reports[beach.id] || []);
  const box = node.querySelector(".reports-list");
  if (!reports.length) return;
  box.hidden = false;
  box.open = state.openLists.has(beach.id) ? state.openLists.get(beach.id) : reports.length <= 3;
  box.addEventListener("toggle", () => state.openLists.set(beach.id, box.open));
  const photos = reports.filter((r) => !isFlagged(r) && (r.photo || r.photoData)).length;
  box.querySelector("summary").textContent = `Recent reports (${reports.length})${photos ? ` · ${photos} photo${photos > 1 ? "s" : ""}` : ""}`;
  box.querySelector("ul").replaceChildren(...reports.map((r) => reportItem(beach, r)));
}

function reportItem(beach, r) {
  const li = el("li", null, "report-item");
  if (isFlagged(r)) {
    li.classList.add("flagged");
    li.append(el("span", `Hidden: beachgoers flagged this report as wrong (${ago(r.time)})`));
    return li;
  }
  const bits = [crowdLabel(r.crowd)];
  if (r.parking) bits.push(PARKING_LABELS[r.parking]);
  bits.push(ago(r.time));
  li.append(el("span", bits.join(" · "), "what"));
  if (r.note) li.append(el("span", `“${r.note}”`, "said"));
  const photoUrl = r.photoData || (r.photo && r.id ? `api/photo?${new URLSearchParams({ beach: beach.id, id: r.id })}` : null);
  if (photoUrl) {
    const thumb = el("button", null, "thumb");
    thumb.type = "button";
    thumb.setAttribute("aria-label", "Open photo");
    const img = el("img");
    img.src = photoUrl;
    img.alt = `Photo of ${beach.name}, ${ago(r.time)}`;
    img.loading = "lazy";
    img.addEventListener("error", () => thumb.remove()); // expired or flagged
    thumb.append(img);
    thumb.addEventListener("click", () => showPhoto(photoUrl, `${beach.name} · ${crowdLabel(r.crowd)} · ${ago(r.time)}`));
    li.prepend(thumb);
  }
  const votes = el("span", null, "votes");
  if (r.id && state.mine.has(r.id)) {
    votes.append(el("span", `Your report · 👍 ${r.up || 0} · 👎 ${r.down || 0}`, "fine"));
  } else if (r.id) {
    const mine = state.myVotes[r.id];
    for (const [vote, icon, label] of [["up", "👍", "Accurate"], ["down", "👎", "Wrong"]]) {
      const b = el("button", `${icon} ${r[vote] || 0}`, "vote");
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", `${label} (${r[vote] || 0})`);
      b.setAttribute("aria-pressed", String(mine === vote));
      b.disabled = !!mine;
      b.addEventListener("click", () => castVote(beach, r, vote, votes));
      votes.append(b);
    }
  }
  li.append(votes);
  return li;
}

function showPhoto(url, caption) {
  const view = $("photo-view");
  view.querySelector("img").src = url;
  view.querySelector("p").textContent = caption;
  if (view.showModal) view.showModal();
  else window.open(url, "_blank", "noopener");
}

const MAX_PHOTO_PX = 1280;
const MAX_PHOTO_BYTES = 250 * 1024;

// Shrinks a photo to a small JPEG and returns it as base64. Drawing it onto a canvas also drops
// the file's hidden metadata, including where it was taken.
async function shrinkPhoto(file) {
  if (!/^image\//.test(file.type || "image/")) throw new Error("That file isn't a photo.");
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Couldn't read that photo. Try a JPEG or PNG."));
      img.src = URL.createObjectURL(file);
    });
  }
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  let scale = Math.min(1, MAX_PHOTO_PX / Math.max(width, height));
  const canvas = document.createElement("canvas");
  for (let tries = 0; tries < 4; tries++, scale *= 0.75) {
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= MAX_PHOTO_BYTES) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      }
    }
  }
  throw new Error("That photo is too big to send.");
}

async function castVote(beach, report, vote, box) {
  for (const b of box.querySelectorAll("button")) b.disabled = true;
  try {
    const totals = demo
      ? { up: (report.up || 0) + (vote === "up"), down: (report.down || 0) + (vote === "down") }
      : await sendVote({ beachId: beach.id, reportId: report.id, vote });
    Object.assign(report, totals);
    state.myVotes[report.id] = vote;
    save_(VOTES_KEY, state.myVotes);
    render();
    setStatus(vote === "up" ? "Thanks for confirming that report." : "Thanks. Reports enough people flag get hidden.");
  } catch (err) {
    if (/already voted/i.test(err.message)) {
      state.myVotes[report.id] = vote;
      save_(VOTES_KEY, state.myVotes);
      render();
    } else {
      for (const b of box.querySelectorAll("button")) b.disabled = false;
    }
    setStatus(err.message, true);
  }
}

// --- Reporter points ---------------------------------------------------------------

// This device's private reporter id (made on first use). Only the server sees it; the board shows names.
function reporterId() {
  let id = load_(REPORTER_KEY);
  if (typeof id !== "string" || !REPORTER_RE.test(id)) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    save_(REPORTER_KEY, id);
  }
  return id;
}

// "Top reporters this week", and how you're doing. Hidden until reports are shared.
async function refreshLeaders() {
  if (demo) return;
  const box = $("leaders");
  const me = load_(REPORTER_KEY);
  let board;
  try {
    board = await getJson(`api/leaders${typeof me === "string" && REPORTER_RE.test(me) ? `?me=${me}` : ""}`);
  } catch {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const list = box.querySelector(".board");
  list.replaceChildren(...board.top.map((row) => {
    const li = el("li", null, row.you ? "mine" : "");
    li.append(el("strong", row.name), document.createTextNode(` · ${row.points} points · ${row.reports} report${row.reports === 1 ? "" : "s"}${row.you ? " (you)" : ""}`));
    return li;
  }));
  if (!board.top.length) list.append(el("li", "No reports yet this week. Send one to top the board!", "empty"));
  const you = box.querySelector(".my-points");
  you.textContent = board.me && board.me.points
    ? `You (${board.me.name}): ${board.me.points} points this week, #${board.me.rank}. ${board.me.total} points all time.`
    : "Report from the beach to earn points.";
  const input = $("name-form").elements.name;
  if (board.me && board.me.named && document.activeElement !== input) input.value = board.me.name;
}

$("name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("name-form").querySelector(".name-msg");
  let name;
  try {
    name = cleanName($("name-form").elements.name.value);
  } catch (err) {
    msg.textContent = err.message;
    return;
  }
  msg.textContent = "Saving…";
  try {
    const res = await fetch("api/leaders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reporter: reporterId(), name }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Couldn't save your name.");
    msg.textContent = "Saved.";
    refreshLeaders();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// --- Alerts ------------------------------------------------------------------

function saveAlerts() {
  save_(ALERTS_KEY, state.alerts);
}

// Where an alert for this beach should open: this search, with the beach highlighted.
function beachLink(beach) {
  const url = new URLSearchParams({
    at: `${state.center.lat.toFixed(4)},${state.center.lon.toFixed(4)}`,
    near: state.center.label === "you" ? beach.name : state.center.label,
    beach: beach.id,
  });
  return `/?${url}`;
}

// This browser's push subscription for the given server key, asking permission first. Resolves
// null when the site can't push (no push keys set up, or a browser without web push); throws with a
// message when this browser can't show notifications at all.
async function pushSubscription() {
  if (!("Notification" in window)) {
    throw new Error(isIOS
      ? "On iPhone, add Beach Check to your Home Screen first (Share → Add to Home Screen), then open it from there and turn this on."
      : "This browser can't show notifications.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in your browser settings, then try again.");
  if (demo || !("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  let res;
  try {
    res = await fetch("api/alerts");
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const { publicKey } = await res.json();
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ||
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) });
}

// Signs this browser up for pushes about one beach. Resolves true when pushes will arrive with
// the site closed, false when alerts only work while the page is open.
async function enablePush(beach, prefs) {
  const sub = await pushSubscription();
  if (!sub) return false;
  const saved = await fetch("api/alerts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ beachId: beach.id, name: beach.name, level: prefs.level, parking: prefs.parking, link: beachLink(beach), subscription: sub.toJSON() }),
  });
  if (!saved.ok) {
    const err = await saved.json().catch(() => ({}));
    throw new Error(err.error || "Couldn't turn on alerts. Try again in a minute.");
  }
  return true;
}

async function disablePush(beachId) {
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return;
  await fetch("api/alerts", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ beachId, endpoint: sub.endpoint }),
  }).catch(() => {});
}

function urlBase64ToBytes(text) {
  const b64 = (text + "=".repeat((4 - (text.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function buildAlertForm(node, beach, open) {
  const form = node.querySelector(".alert-form");
  const toggle = node.querySelector(".alert-toggle");
  const off = form.querySelector(".alert-off");
  const msg = form.querySelector(".alert-msg");
  const current = state.alerts[beach.id];
  const uid = beach.id.replace(/\W/g, "-");
  form.querySelector(".alert-levels").append(
    choice(`alert-${uid}`, 4, "Busy or packed"),
    choice(`alert-${uid}`, 5, "Packed"),
  );
  form.querySelector(`input[value="${current ? current.level : 4}"]`).checked = true;
  form.elements.parking.checked = current ? current.parking : true;
  toggle.textContent = current ? "🔔 Alerts on" : "🔔 Alert me";
  toggle.classList.toggle("on", !!current);
  off.hidden = !current;
  form.querySelector("button[type=submit]").textContent = current ? "Save" : "Turn on alerts";
  form.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    toggle.setAttribute("aria-expanded", String(!form.hidden));
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const prefs = {
      name: beach.name,
      level: Number(form.querySelector(`input[name="alert-${uid}"]:checked`).value),
      parking: form.elements.parking.checked,
    };
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    msg.textContent = "Turning on…";
    try {
      prefs.push = await enablePush(beach, prefs);
      state.alerts[beach.id] = prefs;
      saveAlerts();
      state.favorites.add(beach.id); // alerts are for your beaches
      save_(FAVORITES_KEY, [...state.favorites]);
      syncMorning();
      form.hidden = true;
      render();
      setStatus(prefs.push
        ? `Alerts on for ${beach.name}. You'll get a notification when it's ${prefs.level === 5 ? "packed" : "busy"}${prefs.parking ? " or parking fills up" : ""}, even with the site closed.`
        : `Alerts on for ${beach.name} while this page is open.${demo ? "" : " (Alerts with the site closed aren't set up on this site yet.)"}`);
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  off.addEventListener("click", async () => {
    delete state.alerts[beach.id];
    saveAlerts();
    form.hidden = true;
    render();
    setStatus(`Alerts off for ${beach.name}.`);
    disablePush(beach.id);
  });
}

// While the page is open, alert about watched beaches from the live reports just fetched.
// Uses the same tag as pushes, so a push and this never show twice.
async function checkLiveAlerts() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const alerted = load_(ALERTED_KEY) || {};
  const now = Date.now();
  for (const [id, prefs] of Object.entries(state.alerts)) {
    const live = liveStatus(state.reports[id] || []);
    const reason = alertReason(live, prefs);
    if (!reason || now - (alerted[id] || 0) < ALERT_COOLDOWN_MS) continue;
    alerted[id] = now;
    const { title, body } = alertMessage(prefs.name, live, reason);
    try {
      const reg = "serviceWorker" in navigator && (await navigator.serviceWorker.getRegistration());
      const options = { body, tag: `busy-${id}`, icon: "icon-192.png", data: { url: location.pathname + location.search } };
      if (reg) await reg.showNotification(title, options);
      else new Notification(title, options);
    } catch {
      // notifications unavailable: the "Your beaches today" list still shows it
    }
  }
  save_(ALERTED_KEY, alerted);
}

// A small bar for each hour of the chosen day: taller and warmer is busier. Tap one to plan for it.
function dayBars(node, day, when) {
  const bars = node.querySelector(".bars");
  const now = Date.now();
  for (const h of day) {
    const level = Math.min(5, Math.max(1, Math.round(h.crowd)));
    const bar = el("button", null, `bar level-${level}`);
    bar.type = "button";
    bar.style.setProperty("--h", `${Math.round((h.crowd / 5) * 100)}%`);
    const label = `${hourText(h.hour)}: ${crowdLabel(h.crowd)}`;
    bar.title = label;
    bar.setAttribute("aria-label", `${label}. Plan for this time`);
    if (new Date(when).getHours() === h.hour) bar.classList.add("picked");
    if (h.time + HOUR_MS < now) bar.classList.add("past");
    bar.append(el("span", h.hour % 3 === 0 ? String(h.hour % 12 || 12) : ""));
    bar.addEventListener("click", () => planFor(h.time));
    bars.append(bar);
  }
  node.querySelector(".day-summary").textContent = `${sameDay(when, now) ? "Today" : new Date(when).toLocaleDateString([], { weekday: "long" })}: ${daySummary(day)}`;
}

// Link to this search with the beach highlighted; uses the phone's share sheet when there is one.
async function shareBeach(beach, button) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("at", `${state.center.lat.toFixed(4)},${state.center.lon.toFixed(4)}`);
  url.searchParams.set("near", state.center.label === "you" ? beach.name : state.center.label);
  url.searchParams.set("beach", beach.id);
  const text = `${beach.name} on Beach Check`;
  try {
    if (navigator.share) return await navigator.share({ title: text, url: url.href });
    await navigator.clipboard.writeText(url.href);
    button.textContent = "Link copied";
  } catch (err) {
    if (err && err.name === "AbortError") return; // closed the share sheet
    window.prompt("Copy this link:", url.href);
  }
}

// "Leave by 9:42 AM to get there at 10 AM (about 18 min with traffic then)", and when to leave to
// beat the crowd if the forecast says it gets busy later.
function leaveLines(drive, when, day) {
  const lines = [];
  const now = Date.now();
  const goingNow = $("time").value === "now";
  const arrival = goingNow ? null : when.getTime();
  const trip = (d) => `about ${d} min${trafficFactor(new Date(goingNow ? now : arrival - d * 60000)) > 1 ? " with the usual traffic then" : ""}`;
  if (goingNow) {
    const drv = Math.round(drive.minutes * trafficFactor(new Date(now)));
    lines.push(el("li", `Drive: leave now to arrive about ${fmtClock(now + drv * 60000)} (${trip(drv)})`, "leave"));
  } else {
    const { leave, drive: drv } = leaveTime(arrival, drive.minutes);
    const text = leave < now
      ? `Drive: ${trip(drv)}. Too late to arrive by ${fmtClock(arrival)}.`
      : `Leave by ${fmtClockOn(leave, when)} to get there at ${fmtClock(arrival)} (${trip(drv)})`;
    lines.push(el("li", text, "leave"));
  }
  const busy = busyFrom(day, now);
  if (busy && (goingNow || arrival >= busy - 60 * 60000)) {
    const { leave } = leaveTime(busy, drive.minutes);
    if (leave > now) lines.push(el("li", `Expected busy from ${fmtClock(busy)}: leave by ${fmtClockOn(leave, when)} to beat the crowd`, "leave beat"));
  }
  return lines;
}

const WATER_TEXT = {
  open: "Meets state health standards",
  warning: "Warning: bacteria above state health standards. The county advises staying out of the water here",
  closed: "Closed to swimming by the county",
  unknown: "Status not reported",
};

// One line per county sampling site near the beach, plus the rain advisory after recent rain.
function waterLines(sites) {
  const lines = [];
  const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
  for (const site of sites) {
    const li = el("li", null, `water water-${site.status}`);
    const where = sites.length > 1 || !/^(the )?beach$/i.test(site.name) ? ` at ${site.name}` : "";
    const when = site.date ? ` (tested ${fmtDate(site.date)}${isStale(site) ? ", may be out of date" : ""})` : "";
    li.append(el("strong", `Water quality${where}: `), document.createTextNode(`${WATER_TEXT[site.status]}${when}.`));
    if (site.status !== "open" && site.notes) li.append(el("span", ` ${site.notes}`, "fine"));
    lines.push(li);
  }
  const rain = state.weather ? recentRainMm(state.weather) : 0;
  if (rain >= RAIN_ADVISORY_MM) {
    const amount = imperial ? `${(rain / 25.4).toFixed(1)} in` : `${Math.round(rain)} mm`;
    lines.push(el("li", `Rain advisory: ${amount} of rain in the last 3 days. Health officials advise staying out of the ocean for 72 hours after significant rain, when runoff carries bacteria.`, "water water-warning"));
  }
  return lines;
}

// "Live cams: Leadbetter Point (Surfline) · Stearns Wharf & harbor (SkylineWebcams)"
function camLine(cams) {
  const li = el("li", "Live cams: ");
  cams.forEach((cam, i) => {
    if (i) li.append(document.createTextNode(" · "));
    const a = el("a", cam.name);
    a.href = cam.url;
    a.target = "_blank";
    a.rel = "noopener";
    li.append(a, document.createTextNode(` (${cam.source})`));
  });
  return li;
}

// Every parking option for a hand-checked beach, each with a link to find it on a map.
function lotList(beach) {
  const details = el("details", null, "lots");
  details.append(el("summary", `Where to park (${beach.lots.length})`));
  const list = el("ul");
  for (const lot of beach.lots) {
    const li = el("li");
    const bits = [lot.spaces && `${lot.spaces} spaces`, lot.fee, lot.hours, lot.note].filter(Boolean);
    li.append(el("strong", lot.name), document.createTextNode(bits.length ? ` · ${bits.join(" · ")}` : ""));
    if (!lot.street) {
      const a = el("a", "map");
      a.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lot.name}, ${beach.name}, Santa Barbara County, CA`)}`;
      a.target = "_blank";
      a.rel = "noopener";
      li.append(document.createTextNode(" · "), a);
    }
    list.append(li);
  }
  details.append(list, el("p", "Rates and hours from the City of Santa Barbara, Santa Barbara County Parks and California State Parks. Check posted signs.", "fine"));
  return details;
}

function choice(name, value, label) {
  const wrap = el("label", null, "choice");
  const input = el("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  wrap.append(input, el("span", label));
  return wrap;
}

function buildReportForm(node, beach, open) {
  const form = node.querySelector(".report");
  const toggle = node.querySelector(".report-toggle");
  const uid = beach.id.replace(/\W/g, "-");
  form.querySelector(".crowd-choices").append(...CROWD_LABELS.map((label, i) => choice(`crowd-${uid}`, i + 1, label)));
  form.querySelector(".parking-choices").append(
    ...Object.entries(PARKING_LABELS).map(([value, label]) => choice(`parking-${uid}`, value, label)),
  );
  form.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    toggle.setAttribute("aria-expanded", String(!form.hidden));
  });

  const msg = form.querySelector(".report-msg");
  const preview = form.querySelector(".photo-preview");
  form.elements.photo.addEventListener("change", () => {
    const file = form.elements.photo.files[0];
    preview.hidden = !file;
    form.querySelector(".photo-note").hidden = !file;
    if (file) preview.src = URL.createObjectURL(file);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const crowd = form.querySelector(`input[name="crowd-${uid}"]:checked`);
    const parking = form.querySelector(`input[name="parking-${uid}"]:checked`);
    if (!crowd) return void (msg.textContent = "Pick how crowded it is.");
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    msg.textContent = "Checking you're at the beach…";
    try {
      if (!demo) {
        const here = await currentPosition().catch(() => null);
        if (here && distanceKm(here, beach) > NEAR_BEACH_KM) {
          throw new Error(`You look to be ${fmtDistance(distanceKm(here, beach))} away. Please report from the beach.`);
        }
      }
      const file = form.elements.photo.files[0];
      let photo;
      if (file) {
        msg.textContent = "Preparing photo…";
        photo = await shrinkPhoto(file);
      }
      msg.textContent = "Sending…";
      const { shared, id } = await sendReport({
        beachId: beach.id,
        crowd: Number(crowd.value),
        parking: parking && parking.value,
        note: form.elements.note.value.trim(),
        photo,
        reporter: reporterId(),
        slot: slotKey(new Date()),
      });
      state.shared = shared;
      if (id) {
        state.mine.add(id);
        save_(MINE_KEY, [...state.mine].slice(-100));
      }
      form.hidden = true;
      await refreshReports();
      setStatus(`Thanks! Your report for ${beach.name} is ${shared ? `live for everyone. +${POINTS.report} points` : "saved on this device"}.`);
      if (shared) refreshLeaders();
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}


let lastFit = "";

function drawMap(views) {
  if (!window.L || !state.center) return;
  $("map").hidden = false;
  if (!map) {
    map = L.map("map", { scrollWheelZoom: false, zoomControl: false });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    markers = L.layerGroup().addTo(map);
  }
  markers.clearLayers();
  L.marker([state.center.lat, state.center.lon], {
    icon: L.divIcon({ className: "pin-you", html: "<span></span>", iconSize: [18, 18] }),
    keyboard: false,
  }).bindTooltip(state.center.label === "you" ? "You" : state.center.label).addTo(markers);
  for (const v of views) {
    const level = Math.min(5, Math.max(1, Math.round(v.crowd)));
    const popup = el("div", null, "pop");
    popup.append(el("strong", v.beach.name), el("span", `${crowdLabel(v.crowd)} · ${v.useLive ? "live" : "estimate"}`, `pop-badge level-${level}`));
    L.marker([v.beach.lat, v.beach.lon], {
      icon: L.divIcon({ className: `pin level-${level}${v.useLive ? " live" : ""}`, html: "<span></span>", iconSize: [26, 26] }),
      title: `${v.beach.name}: ${crowdLabel(v.crowd)}`,
      riseOnHover: true,
    })
      .bindPopup(popup, { closeButton: false, offset: [0, -8] })
      .on("click", () => {
        const target = document.querySelector(`.card[data-id="${CSS.escape(v.beach.id)}"]`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
      })
      .addTo(markers);
  }
  map.invalidateSize(); // the map's box may have changed size (layout, first show) since last time
  // Refit only when the set of beaches changes, so refreshes don't undo someone's panning.
  const key = `${state.center.lat},${state.center.lon}|${views.map((v) => v.beach.id).sort().join(",")}`;
  if (key !== lastFit) {
    lastFit = key;
    const points = [[state.center.lat, state.center.lon], ...views.map((v) => [v.beach.lat, v.beach.lon])];
    map.fitBounds(points, { padding: [36, 36], maxZoom: 14 });
  }
}

// --- Loading ---------------------------------------------------------------

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Your browser can't share your location. Search for a town instead."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error("Couldn't get your location. Search for a town instead.")),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 },
    );
  });
}

async function refreshReports() {
  if (!state.beaches.length) return;
  const got = await getReports(state.beaches.map((b) => b.id));
  state.shared = got.shared;
  state.reports = got.reports;
  state.history = got.history;
  state.updated = Date.now();
  if (demo) {
    const seeded = demoReports();
    for (const [id, list] of Object.entries(seeded)) state.reports[id] = [...(state.reports[id] || []), ...list];
    for (const [id, h] of Object.entries(DEMO_HISTORY)) state.history[id] = { ...h, ...state.history[id] };
  }
  render();
  checkLiveAlerts();
}

// Live street-meter counts, where the city publishes them. Optional: failures just hide the line.
async function refreshMeters() {
  const beaches = state.beaches;
  try {
    const meters = await getMeters(beaches);
    if (beaches !== state.beaches) return; // a newer search replaced these beaches
    state.meters = meters;
    if (Object.keys(meters).length) render();
  } catch {
    state.meters = {};
  }
}

// Waves, water temperature and tides. Optional: failures just leave those lines out.
async function refreshMarine() {
  const beaches = state.beaches;
  try {
    const marine = await getMarine(beaches);
    if (beaches !== state.beaches) return; // a newer search replaced these beaches
    state.marine = marine;
    render();
  } catch {
    // keep whatever we had
  }
}

// Amenities from the map for beaches without a hand-checked list. Optional.
async function refreshAmenities() {
  const beaches = state.beaches;
  if (demo || !beaches.some((b) => !b.amenities)) return;
  try {
    const amenities = await getAmenities(beaches);
    if (beaches !== state.beaches) return;
    state.amenities = amenities;
    render();
  } catch {
    // leave the line out
  }
}

// Road drive times from the searched place. Optional: straight-line estimates are used without them.
async function refreshDrives() {
  const beaches = state.beaches;
  const center = state.center;
  try {
    const drives = await getDriveTimes(center, beaches);
    if (beaches !== state.beaches || center !== state.center) return;
    state.drives = drives;
    render();
  } catch {
    // keep the estimates
  }
}

// County water quality testing. Optional: failures just leave those lines out.
async function refreshWater() {
  const beaches = state.beaches;
  try {
    const water = await getWaterQuality(beaches);
    if (beaches !== state.beaches) return;
    state.water = water;
    if (water.length) render();
  } catch {
    // keep whatever we had
  }
}

function beachesStatus(radius, center) {
  const updated = state.updated ? ` Live reports updated ${fmtClock(state.updated)}.` : "";
  return `${state.beaches.length} beaches within ${fmtDistance(radius)} of ${center.label}.${updated}`;
}

// Remembers the place on this device and in the address bar, so a reload or bookmark comes back here.
function rememberPlace(center) {
  if (demo) return;
  const label = center.label === "you" ? "your location" : center.label;
  save_(PLACE_KEY, { lat: center.lat, lon: center.lon, label });
  const url = new URL(location.href);
  if (center === SB_CENTER) {
    url.searchParams.delete("at");
    url.searchParams.delete("near");
  } else {
    url.searchParams.set("at", `${center.lat.toFixed(4)},${center.lon.toFixed(4)}`);
    url.searchParams.set("near", label);
  }
  url.searchParams.delete("q");
  history.replaceState(null, "", url);
}

async function load(center) {
  state.center = center;
  state.meters = {};
  state.marine = {};
  state.water = [];
  state.drives = {};
  state.amenities = {};
  rememberPlace(center);
  setStatus(`Finding beaches near ${center.label}…`);
  let radius = Number($("radius").value);
  state.weather = null;
  // Weather fills in when it arrives; it never holds up the list.
  getWeather(center)
    .then((w) => {
      if (state.center !== center) return;
      state.weather = w;
      if (state.beaches.length) {
        render();
        setStatus(beachesStatus(radius, center));
      }
    })
    .catch(() => {});

  // Around Santa Barbara, show the hand-checked beaches right away, then add any other mapped
  // beaches once the (slower) map lookup answers.
  if (!demo && inSantaBarbara(center)) {
    state.beaches = sbBeaches(center, radius);
    $("plan").hidden = false;
    await refreshReports();
    refreshMarine();
    refreshWater();
    refreshDrives();
    setStatus(beachesStatus(radius, center));
    findBeaches(center, radius)
      .then(async (found) => {
        if (state.center !== center) return; // a newer search took over
        state.beaches = mergeWithCurated(state.beaches.filter((b) => b.curated), found);
        await refreshReports();
        refreshMarine();
        refreshWater();
        refreshDrives();
        refreshAmenities();
        setStatus(beachesStatus(radius, center));
      })
      .catch(() => {}); // the hand-checked list is already showing
    return;
  }

  const lookup = (km) => (demo
    ? Promise.resolve(DEMO_BEACHES.map((b) => ({ ...b, distanceKm: distanceKm(center, b) })).filter((b) => b.distanceKm <= km))
    : findBeaches(center, km)
      .then((found) => mergeWithCurated(sbBeaches(center, km), found))
      .catch((err) => {
        const curated = sbBeaches(center, km);
        if (curated.length) return curated;
        throw err;
      }));
  let beaches;
  try {
    beaches = await lookup(radius);
    // Inland towns are often a little further from the coast than the default radius.
    const widest = Number($("radius").options[$("radius").options.length - 1].value);
    if (!beaches.length && radius < widest) {
      setStatus(`No beaches within ${fmtDistance(radius)}, looking further…`);
      radius = widest;
      $("radius").value = String(widest);
      beaches = await lookup(radius);
    }
  } catch (err) {
    setStatus(`${err.message}. Try again in a minute.`, true);
    return;
  }
  if (state.center !== center) return;
  state.beaches = beaches;
  $("plan").hidden = false;
  if (!state.beaches.length) {
    $("beaches").replaceChildren();
    $("map").hidden = true;
    setStatus(`No named beaches within ${fmtDistance(radius)} of ${center.label}.`);
    return;
  }
  await refreshReports();
  refreshMeters();
  refreshMarine();
  refreshWater();
  refreshDrives();
  refreshAmenities();
  setStatus(beachesStatus(radius, center));
}

$("near-me").addEventListener("click", async () => {
  setStatus("Getting your location…");
  try {
    const pos = await currentPosition();
    await load({ ...pos, label: "you" });
  } catch (err) {
    setStatus(err.message, true);
  }
});

// "Popular" place buttons in the hero, and the location button in the top bar.
for (const b of document.querySelectorAll(".quick [data-place]")) {
  b.addEventListener("click", () => {
    $("place").value = b.dataset.place;
    $("where").requestSubmit();
  });
}
$("near-me-top").addEventListener("click", () => $("near-me").click());
window.addEventListener("resize", () => map && map.invalidateSize());

$("where").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("place").value.trim();
  if (!text) return;
  setStatus(`Looking up ${text}…`);
  try {
    await load(await geocode(text));
  } catch (err) {
    setStatus(err.message, true);
  }
});

// Show the distance menu in the visitor's units.
for (const opt of $("radius").options) opt.textContent = fmtDistance(Number(opt.value)).replace(/\.0 /, " ");

fillPlanMenus();
$("day").addEventListener("change", () => { syncTimeMenu(); render(); });
$("time").addEventListener("change", render);
$("sort").addEventListener("change", render);
for (const id of FILTERS) $(id).addEventListener("change", render);

$("refresh").addEventListener("click", async () => {
  const button = $("refresh");
  button.disabled = true;
  try {
    await refreshReports();
    refreshMeters();
    setStatus(beachesStatus(Number($("radius").value), state.center));
  } catch {
    setStatus("Couldn't refresh. Check your connection.", true);
  } finally {
    button.disabled = false;
  }
});
$("radius").addEventListener("change", () => state.center && load(state.center));

// Keep live reports fresh while the page is open.
setInterval(() => {
  // Don't rebuild the list under someone halfway through a report.
  const reporting = document.querySelector(".report:not([hidden]), .alert-form:not([hidden])");
  if (document.visibilityState === "visible" && !reporting && state.center) {
    refreshReports().then(() => setStatus(beachesStatus(Number($("radius").value), state.center))).catch(() => {});
    refreshMeters();
    refreshLeaders();
  }
}, REFRESH_MS);

refreshLeaders();

// Receives alert pushes (sw.js). Pages work the same without it.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// Where to start: a shared link (?at=lat,lon&near=Name or ?q=Goleta), else the last place
// searched on this device, else Santa Barbara.
function startPlace() {
  if (demo) return DEMO_CENTER;
  const at = (params.get("at") || "").split(",").map(Number);
  if (at.length === 2 && at.every(Number.isFinite) && Math.abs(at[0]) <= 90 && Math.abs(at[1]) <= 180) {
    return { lat: at[0], lon: at[1], label: (params.get("near") || "the shared spot").slice(0, 60) };
  }
  const saved = load_(PLACE_KEY);
  if (!params.get("q") && saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && saved.label) return saved;
  return SB_CENTER;
}

const query = params.get("q");
if (query && !demo) {
  $("place").value = query;
  $("where").requestSubmit();
} else {
  const start = startPlace();
  load(start.lat === SB_CENTER.lat && start.lon === SB_CENTER.lon ? SB_CENTER : start);
}
