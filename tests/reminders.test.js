const test = require("node:test");
const assert = require("node:assert");
const { icsTime, icsEvent, googleCalendarUrl } = require("../js/reminders.js");

const start = new Date(Date.UTC(2026, 9, 19, 17, 0));

test("calendar file with an alarm before the event", () => {
  const ics = icsEvent({ title: "Move car: street sweeping, 10–12", start, end: new Date(Date.UTC(2026, 9, 19, 19)), details: "Mondays 10am – 12pm; hotline (805) 897-1903", alarmMinutes: 30 });
  assert.strictEqual(icsTime(start), "20261019T170000Z");
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261019T170000Z\r\nDTEND:20261019T190000Z\r\n/);
  assert.match(ics, /TRIGGER:-PT30M\r\n/);
  assert.match(ics, /DESCRIPTION:Mondays 10am – 12pm\; hotline \(805\) 897-1903\r\n/); // ; escaped
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test("Google Calendar link", () => {
  const url = new URL(googleCalendarUrl({ title: "Parking meter ends", start }));
  assert.strictEqual(url.searchParams.get("dates"), "20261019T170000Z/20261019T171500Z");
  assert.strictEqual(url.searchParams.get("text"), "Parking meter ends");
});

test("all-day events for sweeping days with no time listed", () => {
  const day = new Date(2026, 9, 26);
  const ics = icsEvent({ title: "Street sweeping today", start: day, allDay: true, alarmMinutes: 240 });
  assert.match(ics, /DTSTART;VALUE=DATE:20261026\r\nDTEND;VALUE=DATE:20261027\r\n/);
  assert.match(ics, /TRIGGER:-PT240M/);
  assert.strictEqual(new URL(googleCalendarUrl({ title: "x", start: day, allDay: true })).searchParams.get("dates"), "20261026/20261027");
});
