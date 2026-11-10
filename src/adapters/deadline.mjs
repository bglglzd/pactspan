import { instant, requireValue, zone } from '../core/data.mjs';

export const DEADLINE_VERSION = 'pactspan-deadline-v1';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const formatters = new Map();
function parts(at, timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  const value = Object.fromEntries(formatters.get(timeZone).formatToParts(at).filter(row => row.type !== 'literal').map(row => [row.type, Number(row.value)]));
  return [value.year, value.month, value.day, value.hour, value.minute, value.second];
}
function calendar(year, month, day, hour = 0, minute = 0, second = 0) {
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  requireValue(year >= 2020 && year <= 2100 && value.getUTCFullYear() === year && value.getUTCMonth() + 1 === month
    && value.getUTCDate() === day && hour >= 0 && hour < 24 && minute >= 0 && minute < 60 && second >= 0 && second < 60, 'Invalid deadline calendar');
  return value;
}
const isoDate = values => `${values[0]}-${String(values[1]).padStart(2, '0')}-${String(values[2]).padStart(2, '0')}`;

function localInstants(values, timeZone) {
  const wall = calendar(...values).getTime(); const matches = [];
  // Contemporary supported dates use minute-granularity IANA offsets. Enumerate
  // every offset in ±24h, including half/quarter-hour zones, rather than choosing
  // one side of a DST fold or normalizing a nonexistent wall time.
  for (let offset = -24 * 60; offset <= 24 * 60; offset++) {
    const candidate = wall - offset * 60_000;
    if (parts(candidate, timeZone).every((value, index) => value === values[index])) matches.push(new Date(candidate).toISOString());
  }
  return matches;
}

/** Deterministic narrow grammar. Unsupported wording remains unresolved, with raw model output retained by the caller. */
export function resolveDeadline(due, source) {
  if (due === null) return { due: null, status: 'absent', version: DEADLINE_VERSION };
  const literal = due.literal;
  const unresolved = (reason, precision = 'unknown', timeZone = null) => ({ due: { literal, resolved: null, precision, zone: timeZone },
    status: 'unresolved', reason, version: DEADLINE_VERSION });
  if (!literal || !source.segments.some(segment => segment.text.includes(literal))) return { ...unresolved('Deadline wording is not an exact source substring'), unsupported: true };
  const value = literal.trim().toLowerCase();
  try {
    const explicit = value.match(/^(?:by |at |к |до )?(\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:z|[+-]\d{2}:\d{2}))$/);
    if (explicit) return { due: { literal, resolved: instant(explicit[1].replace('t', 'T').replace('z', 'Z'), 'Deadline instant'), precision: 'instant', zone: 'UTC' },
      status: 'resolved', method: 'explicit-offset-instant', version: DEADLINE_VERSION };
    let timeZone = source.time_zone;
    if (/(?:london time|по лондону)/u.test(value)) timeZone = 'Europe/London';
    else if (/(?:moscow time|по москве)/u.test(value)) timeZone = 'Europe/Moscow';
    else if (/\butc\b/.test(value)) timeZone = 'UTC';
    if (timeZone !== null && timeZone !== undefined) zone(timeZone, 'Deadline zone');

    let date; let time = null;
    const relative = value.match(/^(today|tomorrow|сегодня|завтра)(?: (?:by|at|к|до) (\d{1,2}):(\d{2}))?(?: (?:london time|moscow time|utc|по москве|по лондону))?$/u);
    if (relative) {
      if (!source.meeting_at || !source.time_zone) return unresolved('Relative deadlines require an explicit meeting instant and IANA zone');
      // The relative day is the meeting's local calendar day, even when a
      // separately stated deadline zone differs.
      const anchor = parts(Date.parse(instant(source.meeting_at, 'Deadline meeting anchor')), source.time_zone);
      const day = calendar(...anchor.slice(0, 3));
      if (['tomorrow', 'завтра'].includes(relative[1])) day.setUTCDate(day.getUTCDate() + 1);
      date = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
      if (relative[2] !== undefined) time = [Number(relative[2]), Number(relative[3]), 0];
    } else {
      const datePattern = '(\\d{1,2}) ([a-zа-яё]+) (\\d{4})';
      const timed = value.match(new RegExp('^(?:by|at|к|до) (\\d{1,2}):(\\d{2})(?: (?:london time|moscow time|utc|по москве|по лондону))? (?:on |на |до )?' + datePattern + '$', 'u'));
      const dated = value.match(new RegExp('^(?:on |by |до |на )?' + datePattern + '$', 'u'));
      if (timed) { time = [Number(timed[1]), Number(timed[2]), 0]; const month = Math.max(MONTHS.indexOf(timed[4]), RU_MONTHS.indexOf(timed[4])) + 1; date = [Number(timed[5]), month, Number(timed[3])]; }
      else if (dated) { const month = Math.max(MONTHS.indexOf(dated[2]), RU_MONTHS.indexOf(dated[2])) + 1; date = [Number(dated[3]), month, Number(dated[1])]; }
      else {
        const numeric = value.match(/^(?:on |by |до |на )?(\d{4})-(\d{2})-(\d{2})$/u);
        if (!numeric) return unresolved('Deadline wording is outside the supported exact grammar');
        date = numeric.slice(1).map(Number);
      }
    }
    calendar(...date, ...(time ?? [0, 0, 0]));
    if (!time) return { due: { literal, resolved: isoDate(date), precision: 'date', zone: timeZone ?? null }, status: 'date-only',
      method: relative ? 'anchored-relative-date' : 'explicit-date', version: DEADLINE_VERSION };
    if (!timeZone) return unresolved('A wall-clock deadline requires an explicit IANA zone', 'instant');
    const matches = localInstants([...date, ...time], timeZone);
    if (matches.length !== 1) return unresolved(matches.length ? 'The local deadline occurs more than once' : 'The local deadline does not exist', 'instant', timeZone);
    return { due: { literal, resolved: instant(matches[0], 'Resolved deadline'), precision: 'instant', zone: timeZone }, status: 'resolved',
      method: relative ? 'anchored-relative-instant' : 'explicit-local-instant', version: DEADLINE_VERSION };
  } catch { return unresolved('Deadline calendar or interpretation context is invalid'); }
}

export function deadlineUnknowns(previous, resolution) {
  if (resolution.status === 'absent') return previous;
  const known = new Set(['due', 'due.literal', 'due.resolved', 'due.precision', 'due.zone', 'due.year', 'due.date', 'due.time_zone']);
  if (resolution.status === 'resolved') known.add('due.cutoff');
  if (resolution.status === 'unresolved') return [...new Set([...previous, 'due.resolved'])];
  return [...new Set([...previous.filter(field => !known.has(field)), ...(resolution.status === 'date-only' ? ['due.cutoff'] : [])])].sort();
}
