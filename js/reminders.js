// Calendar reminders for parking (a meter or time limit running out, street sweeping): an .ics file
// for Apple Calendar / Outlook and a Google Calendar link. The phone's own calendar sounds the alarm,
// which keeps working when the browser is closed or the phone is locked.
// Pure functions, no DOM, so they can be tested in Node.

// 20261019T170000Z
const icsTime = (date) => new Date(date).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const icsText = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// An iCalendar file with one event and an alarm `alarmMinutes` before it starts.
// With allDay, start is a local date and the event covers that whole day.
function icsEvent({ title, start, end, details = "", location = "", alarmMinutes = 10, uid, allDay = false }) {
  const day = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const next = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Beach Check//Parking reminder//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid || `${icsTime(start)}-${Math.abs(hashText(title))}@beachcheck`}`,
    `DTSTAMP:${icsTime(Date.now())}`,
    ...(allDay
      ? [`DTSTART;VALUE=DATE:${day(new Date(start))}`, `DTEND;VALUE=DATE:${day(next(new Date(start)))}`]
      : [`DTSTART:${icsTime(start)}`, `DTEND:${icsTime(end || new Date(new Date(start).getTime() + 15 * 60000))}`]),
    `SUMMARY:${icsText(title)}`,
    ...(details ? [`DESCRIPTION:${icsText(details)}`] : []),
    ...(location ? [`LOCATION:${icsText(location)}`] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(title)}`,
    `TRIGGER:-PT${Math.max(0, Math.round(alarmMinutes))}M`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function hashText(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

// A Google Calendar "add event" link (Google applies the user's default reminder).
function googleCalendarUrl({ title, start, end, details = "", location = "", allDay = false }) {
  const day = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const s = new Date(start);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: allDay
      ? `${day(s)}/${day(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1))}`
      : `${icsTime(start)}/${icsTime(end || new Date(s.getTime() + 15 * 60000))}`,
    details,
    location,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

if (typeof module !== "undefined") module.exports = { icsTime, icsEvent, googleCalendarUrl };
