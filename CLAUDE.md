# Beach Check (personal version): notes for continuing

Read this first. It records what this project is, how the owner wants work done, where things stand,
and what's next. Last updated October 14, 2026.

## What this is

**Beach Check**: a website showing how crowded Santa Barbara beaches are, with parking, water
quality, tides, surf, hazards and alerts. Plain HTML/CSS/JS (no build step) plus Vercel serverless
functions in `api/`.

- **This repo:** `naterosen8/beachtrackermine` (the owner's personal version). Branch: `main`.
- **Live site:** https://beachtrackermine.vercel.app (Vercel project `beachtrackermine-4d6j`, which
  also answers at beachtrackermine-4d6j.vercel.app). Every push to `main` deploys automatically.
- **The group's version is separate:** `naterosen8/BeachTracker`, live at
  https://beachtrackingtmp.vercel.app. It's a group project and must stay as the original.
  **Never push to, merge into, or change `BeachTracker`** unless the owner explicitly asks.
  (Its `main` includes an early round of features: surf/tides/hourly forecast/favorites/filters/
  share links. The owner decided to keep that.)

## How the owner wants work done

- **No faking, no guesswork.** Every fact shown must come from a named official or credible source
  that was checked. If a source doesn't exist (e.g. no agency publishes a "safe below X ft" tide
  height), say so and don't invent one.
- **Ask permission before building.** Research first, present what the sources support and the plan,
  then wait for a yes.
- **Each feature fully done before the next:** unit tests, a real-browser test, commit, push, confirm
  the Vercel deploy, then report.
- Explain plainly; the owner isn't a programmer. Give exact click-by-click steps for any settings.
- Goal for the product: make it *needed*, not just wanted: prevent real bad outcomes (getting sick,
  tickets, getting cut off by the tide, dangerous surf, wasted trips).

## Setup still to do (owner's side)

The shared database (Upstash Redis) is **connected** in Vercel. Still missing, so shared reports,
votes, the leaderboard and all push notifications report "not configured" (HTTP 503):

1. **Vercel → beachtrackermine project → Settings → Environment Variables**, add:
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`: web push keys. A pair was generated and given to the
     owner in chat on October 9–10, 2026. **Never commit the private key** (this repo is public).
     If lost, make a new pair: `npx web-push generate-vapid-keys` (anyone who turned on alerts with
     the old pair must turn them on again).
   - `VAPID_SUBJECT` = `mailto:naterosen8@gmail.com`
   - `CRON_SECRET` = any long random text
   Then **Deployments → ⋯ → Redeploy** (settings only apply to new deployments).
2. **GitHub → this repo → Settings → Secrets and variables → Actions → New repository secret**:
   `CRON_SECRET` with the same value as in Vercel. Until then the 15-minute safety check skips.
3. Then verify: `api/reports`, `api/leaders`, `api/alerts`, `api/morning`, `api/hazards` should stop
   returning 503, and test the alert flows on the live site.

The owner couldn't find the Environment Variables page once; walk them through it step by step.

## Features (all live)

See README.md for details and sources. In short:
- Crowd: live beachgoer reports (with votes, photos), hour-by-hour estimates, "Right now" best picks.
- Conditions: weather, surf, water temperature (Open-Meteo); **official NOAA tides** from the
  nearest station; documented high-tide cut-off warnings (Isla Vista, Goleta, Arroyo Burro) with
  sources; sunrise/sunset.
- Safety: Santa Barbara County water quality (Open/Warning/Closed); rain advisory; **National Weather
  Service beach hazards** by NWS zone (Santa Barbara beaches = CAZ350).
- Parking: city lot info; road drive times and "leave by" (OSRM); **street sweeping check** from the
  City of Santa Barbara's official map data; meter and sweeping reminders via the phone's calendar.
- Personal: favorites, filters, share links, busy alerts, morning summary (daily Vercel cron,
  `vercel.json`), safety alerts (GitHub Actions every 15 min, `.github/workflows/hazard-check.yml`),
  reporter points and weekly leaderboard.
- Design: premium redesign (illustrated hero, Fraunces + Inter, sticky map, light/dark, phones from
  320 px). Clicking a beach card flies the map to it.

## Working on the code

- Run tests: `npm install` once, then `node --test tests/*.test.js` (101 passing as of Oct 14, 2026).
- Look at the site: `python3 -m http.server 8766` and open http://localhost:8766 (`?demo` shows
  sample Los Angeles beaches with live reports).
- Test the server features locally: `node tools/devserver.js "$PWD" 8790` serves the site, runs the
  `api/` functions and fakes the Upstash database in memory. Set `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` (generate a throwaway pair) and `CRON_SECRET` in the environment first to test
  push/alerts. Send an `x-test-ip` header to act as different visitors (only to localhost; adding it
  to every request breaks calls to api.weather.gov).
- Browser checks: Playwright with headless Chromium. Headless Chromium can't show real notifications;
  stub `Notification`/`PushManager` in tests.
- Known cloud-sandbox quirks (not site bugs): the sandbox proxy rejects `;` in browser URLs (OSRM),
  Open-Meteo sometimes rate-limits the shared IP, public Overpass servers are often busy.
- Commit messages: plain descriptions of what changed and why.

## Ideas not yet built (from brainstorming)

- Beach diary and a yearly "your year at the beach" recap.
- Personalized picks that learn what you like.
- Trusted-reporter badges whose reports count more.
- Local business perks for top reporters.
- Dog rules per beach (needs official sources checked first).
- Morning summary could mention NWS hazards.
