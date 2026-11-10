export class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; }
}

export function requireValue(condition, message) {
  if (!condition) throw new InputError(message);
}

export function object(value, path) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${path} must be an object`);
  return value;
}

export function fields(value, allowed, path) {
  object(value, path);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  requireValue(!extra.length, `${path} contains unknown fields: ${extra.join(', ')}`);
  return value;
}

export function text(value, path, maximum = 160, { nullable = false, empty = false } = {}) {
  if (nullable && value === null) return null;
  requireValue(typeof value === 'string' && value.length <= maximum && (empty || value.length > 0),
    `${path} must be ${empty ? '' : 'nonempty '}text of at most ${maximum} UTF-16 units`);
  for (const character of value) {
    const code = character.charCodeAt(0);
    requireValue(character.length !== 1 || code < 0xD800 || code > 0xDFFF, `${path} contains invalid Unicode`);
  }
  return value;
}

export function identifier(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value),
    `${path} must be a short ASCII identifier`);
  return value;
}

export function integer(value, path, minimum = 0, maximum = 1_000_000) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${path} must be an integer in ${minimum}..${maximum}`);
  return value;
}

export function list(value, path, maximum = 256) {
  requireValue(Array.isArray(value) && value.length <= maximum, `${path} must be a list of at most ${maximum} items`);
  return value;
}

export function jsonData(value) {
  const pending = [[value, '$', 0]];
  let nodes = 0;
  while (pending.length) {
    const [item, path, depth] = pending.pop();
    requireValue(++nodes <= 20_000 && depth <= 24, 'Data exceeds the supported shape limits');
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'string') { text(item, path, 262_144, { empty: true }); continue; }
    if (typeof item === 'number') { requireValue(Number.isFinite(item), `${path} must be finite`); continue; }
    if (Array.isArray(item)) {
      list(item, path, 5000);
      item.forEach((child, index) => pending.push([child, `${path}[${index}]`, depth + 1]));
    } else {
      object(item, path);
      const entries = Object.entries(item);
      requireValue(entries.length <= 1000, `${path} has too many fields`);
      for (const [key, child] of entries) {
        text(key, `${path} field name`, 160);
        requireValue(!['__proto__', 'prototype', 'constructor'].includes(key), `${path} contains a reserved field`);
        pending.push([child, `${path}.${key}`, depth + 1]);
      }
    }
  }
  return value;
}

export function canonical(value) {
  jsonData(value);
  function ordered(item) {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])]));
    }
    return item;
  }
  return JSON.stringify(ordered(value));
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? text(value, 'hash input', 2_000_000, { empty: true }) : canonical(value));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function instant(value, path) {
  text(value, path, 40);
  requireValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)), `${path} must be an ISO instant with an explicit offset`);
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/).slice(1).map(Number);
  const calendar = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  requireValue(parts[0] >= 2020 && parts[0] <= 2100 && calendar.getUTCFullYear() === parts[0]
    && calendar.getUTCMonth() === parts[1] - 1 && calendar.getUTCDate() === parts[2]
    && parts[3] < 24 && parts[4] < 60 && parts[5] < 60, `${path} has an invalid or unsupported calendar date`);
  const resolved = new Date(value);
  requireValue(resolved.getUTCFullYear() >= 2020 && resolved.getUTCFullYear() <= 2100, `${path} resolves outside the supported calendar range`);
  return resolved.toISOString();
}

export function zone(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  text(value, path, 80);
  requireValue(value === 'UTC' || /^[A-Za-z_+-]+\/[A-Za-z_+\/-]+$/.test(value), `${path} must be an IANA zone or null`);
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); }
  catch { throw new InputError(`${path} is an unknown IANA zone`); }
  return value;
}
