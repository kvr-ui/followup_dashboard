// The one place that knows the team works in IST.
//
// The container runs with TZ=Asia/Kolkata, so `getHours()` and friends happen to
// be right in production — but they are wrong on any dev machine, and a day key
// built from them silently changes meaning when the TZ does. Every helper here
// is explicit about IST, so the result is the same wherever the code runs.
//
// IST has no daylight saving, so a fixed offset is exact.

const IST_OFFSET_MS = 330 * 60000;

/**
 * A real Date, or null — never an Invalid Date that would poison a sort.
 * Accepts a Date, a timestamp number, or a string. Meta writes offsets without a
 * colon ('2026-10-01T10:00:00+0530'), which V8 rejects; it gets its colon here.
 */
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d =
    typeof value === 'number'
      ? new Date(value)
      : new Date(String(value).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A Date whose UTC fields read as IST wall-clock time, or null. */
function istShift(value) {
  const d = toDate(value);
  return d ? new Date(d.getTime() + IST_OFFSET_MS) : null;
}

/** 'YYYY-MM-DD' in IST, or null. Defaults to now. */
function istDayKey(value = new Date()) {
  const d = istShift(value);
  return d ? d.toISOString().slice(0, 10) : null;
}

/** 'YYYY-MM' in IST, or null. */
function istMonth(value) {
  const d = istShift(value);
  return d ? d.toISOString().slice(0, 7) : null;
}

/** { hour, weekday } of an instant in IST (weekday: 0 = Sunday), or null. */
function istParts(value) {
  const d = istShift(value);
  return d ? { hour: d.getUTCHours(), weekday: d.getUTCDay() } : null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC instant of 00:00 IST on a 'YYYY-MM-DD', or null for anything else. */
function istDayStart(ymd) {
  if (!DAY_RE.test(ymd || '')) return null;
  const d = new Date(`${ymd}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { IST_OFFSET_MS, toDate, istShift, istDayKey, istMonth, istParts, istDayStart };
