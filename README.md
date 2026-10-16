# Beach Check

The local beach app for Isla Vista and UCSB: Depressions, Pescadero (Peskys), Devereux (Devs),
Sands and the rest of Santa Barbara. Students check conditions and crowds, UCSB clubs post meetups,
and local businesses pay to advertise (a monthly sponsorship, or paid posts in a beach's feed;
always labeled "Sponsored").

See how busy the beaches near you are before you leave: crowd level, parking, weather and directions.
Beachgoers report how crowded a beach is and how parking looks, and everyone sees it live. When
nobody has reported, the site estimates the crowd from the time of day, weekday or weekend, season,
the weather forecast and past reports for that beach.

Plain HTML, CSS and JavaScript. No build step.

## Santa Barbara first

The site opens on Santa Barbara. Its main public beaches come from a hand-checked list
(`js/santa-barbara.js`) instead of map data alone, which gets this area wrong (Hendry's and
Arroyo Burro listed as two beaches, a private beach included, Goleta Beach missing, almost no parking
details). Other mapped beaches nearby (More Mesa, Ellwood, ...) are added after it.

**Isla Vista's spots** are listed under the names locals use, with locations from OpenStreetMap
checked against UCSB A.S. Environmental Affairs' [beach map](https://evpla.as.ucsb.edu/beach-maps/):
Depressions (the old "Isla Vista Beach" entry, so its past reports still count), Pescadero (Peskys),
Devereux (Devs) and Sands. Devereux and Sands use the county's "Sands @ Coal Oil Point" water testing
site and the UCSB permit lot on Seaway Drive that [Coal Oil Point Reserve](https://copr.nrs.ucsb.edu/visiting/parking-and-directions/)
points visitors to. Sands shows the reserve's [rules](https://copr.nrs.ucsb.edu/public/) (no dogs;
snowy plover protection March 15 – September 15); Devereux allows dogs on leash
([reserve Q&A](https://copr.nrs.ucsb.edu/dog-prohibition-at-coal-oil-point-reserve-qa/)). Pescadero
warns that its stairs are closed ([Santa Barbara Independent, Oct 13, 2026](https://www.independent.com/2026/10/13/isla-vistas-coastal-access-debacle-on-the-eve-of-el-nino/)).

Parking for each beach lists the official lots, spaces, rates and hours:

- **City waterfront lots** (Leadbetter, Harbor West, Harbor Main, Stearns Wharf, Garden Street,
  Palm Park, Cabrillo East and West, SBCC La Playa): rates and hours from the City's
  [FY2026 Waterfront fee schedule](https://santabarbaraca.gov/sites/default/files/2026-02/FY26%20Waterfront%20Harbor%20Slip,%20Mooring,%20and%20User%20Fees%20-%20Full%20List%20of%20Fees.pdf)
  ($3.50/hr, $20/day max, 8 a.m.–10 p.m.; Stearns Wharf 90 min free then $4/hr); space counts from
  the City's [lot maps](https://santabarbaraca.gov/things-do/waterfront/waterfront-parking).
- **County beach parks** (Arroyo Burro, Goleta Beach, Lookout Park, Rincon Beach Park): hours
  (8 a.m.–sunset) and seasonal lifeguards from [County Parks](https://www.countyofsb.org/cd-parks-arroyo-burro-beach);
  the county [fee schedule](https://www.countyofsb.org/1096/Fee-Schedule) charges no day-use fee at these parks.
- **Carpinteria State Beach**: $10 vehicle day use, sunrise–sunset, no dogs on the beach, from
  [California State Parks](https://www.parks.ca.gov/?page_id=599).
- Street parking (Butterfly Beach, Isla Vista) and Carpinteria's Linden Ave lots from OpenStreetMap.

Santa Barbara has no live parking data to use: the City's real-time downtown parking page has been
retired, and the waterfront lots never had live counts. Live parking here comes from beachgoer reports.

## How it works

- **Beaches and parking**: OpenStreetMap (Overpass API): named beaches within 10–50 km, and parking
  lots within 600 m of each.
- **Live street parking (Los Angeles only)**: City of Los Angeles open data (LADOT parking meter
  occupancy), updated every minute by sensors in the meters. For beaches in the city (e.g. Venice),
  the card shows how many sensor-equipped street meters within 800 m are free right now. It covers
  street meters only, not beach lots, and ignores sensors that haven't reported for 24 hours.
  Checked and not used: Santa Monica's live lot API has been shut down, and Laguna Beach's
  parking app doesn't publish its data. Other beach cities checked publish no live counts.
- **Weather**: Open-Meteo hourly forecast (temperature, rain, wind, UV) for the time you plan to go,
  up to a week ahead.
- **Surf and water temperature** (`js/conditions.js`): Open-Meteo Marine hourly wave height and period
  and sea surface temperature, for every beach in one request.
- **Tides** (`js/tides.js`, `js/tide-stations.js`): official NOAA high/low predictions (feet above
  mean lower low water, as in tide tables) from the nearest NOAA station within 40 km, one request per
  station. California's 193 stations are stored in the app (NOAA's full list is 2 MB). Elsewhere the
  Open-Meteo modelled sea level is used, labelled as modelled, with times only.
- **High-tide cut-offs**: Isla Vista, Goleta Beach and Arroyo Burro show a documented warning quoted
  from its source (County Fire via the Daily Nexus, the California Coastal Trail guide, the Santa
  Barbara Independent) next to that day's NOAA tide times. No agency publishes a "safe below" height
  for these beaches, so the app never shows a safe time.
- **Water quality** (`js/water.js`): Santa Barbara County Environmental Health's weekly bacteria
  testing (Open / Warning / Closed, with the sample date), read live from the public layer behind the
  county's [Ocean Water Monitoring map](https://www.countyofsb.org/ch-ocean-water-monitoring-program).
  Hand-checked beaches use their own sampling sites; other beaches use the nearest site within 1 km.
  Beaches under a warning drop down the best picks, and "No water warnings" hides them. After 0.1 in
  of rain in the last 72 hours (Open-Meteo, past 3 days) a rain advisory is shown. The state's
  BeachWatch data was checked too, but it lags months behind.
- **Amenities** (`js/amenities.js`): restrooms, showers, drinking water, food, BBQ grills, fire rings,
  picnic tables, playgrounds, volleyball and beach wheelchairs. Santa Barbara's are hand-checked
  against the City's Parks & Recreation beach pages and the county parks' feature lists; elsewhere
  they come from OpenStreetMap features within 400 m, in a separate small query after the beaches
  show. Filters: restrooms, showers, food, fire rings.
- **Beach hazards** (`js/hazards.js`): active National Weather Service alerts that matter on the
  beach (rip current, beach hazards, high surf, coastal flood, sneaker wave, tsunami) for each beach's
  NWS land forecast zone, in one request. Santa Barbara's beaches are in zone CAZ350 (checked against
  api.weather.gov); others look their zone up (the beach point, then nearby points, at most 9 lookups,
  remembered on the device). Shown as a red banner with the NWS wording; counted in best picks and the
  "No safety warnings" filter.
- **Safety alerts** (`api/hazards.js`, `.github/workflows/hazard-check.yml`): turn on in "Your beaches
  today" to get a push for each new NWS beach alert or county water closure at your starred beaches.
  GitHub Actions calls the check every 15 minutes (GitHub may start runs a few minutes late), and each
  hazard is pushed once.
- **Live cams**: hand-checked camera links for Santa Barbara beaches: the SkylineWebcams cam over
  Stearns Wharf and the harbor, and Surfline's Leadbetter Point, Campus Point and Carpinteria cams.
- **Sunrise and sunset**: worked out on the device from the beach's position and date.
- **Hour by hour**: each beach shows the estimated crowd from 6 AM to 8 PM on the chosen day, with
  when it's busiest and quieter. Tap an hour to plan for it.
- **Place search**: OpenStreetMap Nominatim, or the browser's location.
- **Live reports**: `api/reports.js`, a Vercel function storing reports in Upstash Redis. Recent
  reports (last 3 hours, newer ones count more) give the live crowd and parking. Every report also
  adds to that beach's totals per weekday/weekend hour, which improves future estimates.
- **Votes on reports** (`api/votes.js`): every report lists under "Recent reports" with 👍/👎. One
  vote per visitor per report, never on your own. Each net upvote adds a quarter to a report's
  weight in the live crowd (up to double); a net downvote halves it; 2+ downvotes outnumbering the
  upvotes hide it as flagged.
- **Photos with reports** (`api/photo.js`): a report can include a photo. The page shrinks it to a
  JPEG of at most 1280 px and 250 KB before sending; redrawing it also strips its metadata, including
  where it was taken. Photos are kept for 6 hours like the reports, and a report flagged by votes
  stops serving its photo. Without the shared store, only the newest photo is kept on the device.
- **Reporter points** (`js/points.js`, `api/leaders.js`): each device gets a private random reporter
  id (sent with reports, never shown). +10 points per report, +2 per upvote it gets, -2 per downvote.
  "Top reporters this week" shows the top 10 by nickname (or "Beachgoer" plus four characters derived
  from the id) and your own rank; boards start each Monday (UTC) and lifetime totals are kept too.
- **Estimates** (`js/crowd.js`): typical hourly pattern × weekend boost × season (flipped south of
  the equator) × weather, blended with the beach's own past reports once there are at least 3.
- **Directions**: opens Google Maps driving directions to the beach.
- **Parked? Avoid a ticket** (`js/sweeping.js`, `js/reminders.js`): "Check where I'm parked" looks up
  the City of Santa Barbara's official street sweeping routes (the layer behind
  santabarbaraca.gov/StreetSweeping) within 30 m of you and gives the next sweeping, with both sides of
  the street when they differ. Only schedules that say exactly when become dates ("Wednesdays 2x A
  Month" is shown as written; "2nd & 4th Mondays" gets the date but no time). Holiday and rain
  cancellations aren't published as data, so the hotline is shown. The meter/time-limit reminder and
  sweeping reminders go to the phone's own calendar (.ics file or Google Calendar link), which alerts
  even with the site closed.
- **Leave by**: road drive times from the searched place to every beach in one request to the public
  [OSRM](https://project-osrm.org/) router (OpenStreetMap roads; within its fair-use policy, one
  request per search), falling back to a straight-line estimate. Typical traffic is added by rule
  (weekday 7–9 AM and 4–7 PM: +35%; weekend 10 AM–5 PM: +20%). Each card says when to leave to arrive
  at the chosen time and, when the forecast says it gets busy later, when to leave to beat the crowd.
- **My beaches and filters**: star beaches to keep them (saved on this device), and filter to your
  beaches, lifeguarded beaches, dog-friendly beaches or free parking.
- **Alerts** (`js/alerts.js`, `api/alerts.js`, `sw.js`): tap "Alert me" on a beach to get a
  notification when beachgoers report it busy or packed, or its parking full (at most once every
  3 hours per beach). Each new report triggers the pushes straight away (no scheduled job needed),
  so they arrive with the site closed. While the page is open it also checks on each refresh.
  On iPhone, web notifications need the site added to the Home Screen first (iOS 16.4+).
- **Your beaches today**: for starred beaches, what beachgoers report now or when the forecast
  says they'll be busy.
- **Morning summary** (`api/morning.js`, `api/_summary.js`): one notification each morning for your
  starred beaches ("East Beach: busy 12–5 PM · 68°F · water quality warning"), from the same forecast,
  weather and water testing as the page. Vercel Cron calls it daily at 15:00 UTC (`vercel.json`): 8 AM
  Pacific in summer, 7 AM in winter; subscribers whose local time isn't 6–11 AM then are skipped.
  Turning it on sends the first summary straight away; changing your starred beaches updates it.
- **Links**: `?q=Goleta` searches a place; `?at=34.41,-119.83&near=Goleta&beach=<id>` opens a spot
  with one beach highlighted (what the Share button sends). The site also remembers the last place
  you looked at.

Reports are checked against your location (must be within 2 km of the beach), limited to one per
beach every 10 minutes per visitor, and notes are capped at 140 characters.

## Run it

```sh
python3 -m http.server 8000   # open http://localhost:8000 (reports save to this device only)
                              # http://localhost:8000/?demo shows sample Los Angeles beaches
npx vercel dev                # full site including /api/reports
node --test tests/*.test.js   # run the tests
```

## Deploy

1. Import this repository on Vercel (no build settings needed).
2. Add an Upstash Redis store from the Vercel Marketplace (Storage → Upstash), which sets
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or set `UPSTASH_REDIS_REST_URL` /
   `UPSTASH_REDIS_REST_TOKEN` yourself). Without it, reports are saved only on each visitor's device.
3. For alerts with the site closed, create web push keys once (`npx web-push generate-vapid-keys`)
   and add them as environment variables `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (optionally
   `VAPID_SUBJECT`, a `mailto:` address or the site's URL). Without them, alerts only work while
   the page is open.
5. For safety alerts every 15 minutes, add the same `CRON_SECRET` value as a GitHub repository secret
   (Settings → Secrets and variables → Actions → New repository secret). Until then the workflow skips.
4. For the morning summary, add a `CRON_SECRET` environment variable (any long random text). Vercel
   sends it with its daily cron call, and the summary refuses calls without it.

## Roadmap

1. [x] Find beaches near you, crowd estimates, parking, weather, directions
2. [x] Live beachgoer reports, with estimates that learn from past reports
3. [x] Alerts: tell me when my favorite beach gets busy or parking fills up
4. [x] Favorites and a "my beaches" view, filters, share links, plan up to a week ahead
5. [x] Photos with reports, and up/down votes on reports to weed out bad ones
6. [x] Tides, water quality and surf conditions
7. [x] Reporter points and a weekly leaderboard (no accounts needed)
8. [x] Isla Vista spots: Depressions, Pescadero, Devereux, Sands
9. [ ] Monthly business sponsors (labeled "Sponsored")
10. [ ] Local feed per beach: club posts and paid business posts
11. [ ] UCSB club listings
