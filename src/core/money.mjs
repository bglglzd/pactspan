import { requireValue, text } from './data.mjs';

export function amount(value, path = 'amount') {
  text(value, path, 32);
  const parts = value.match(/^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/);
  requireValue(parts !== null, `${path} must be a nonnegative decimal string with at most two fractional digits`);
  const cents = BigInt(parts[1]) * 100n + BigInt((parts[2] ?? '').padEnd(2, '0'));
  requireValue(cents <= 100_000_000_000n, `${path} exceeds the supported 1000000000 limit`);
  const fraction = (parts[2] ?? '').replace(/0+$/, '');
  return parts[1] + (fraction ? '.' + fraction : '');
}

export function currencyCode(value, path = 'currency') {
  requireValue(typeof value === 'string' && /^[A-Z]{3}$/.test(value), `${path} must be an explicit three-letter uppercase currency code`);
  return value;
}

export function wireAmount(value) {
  const normalized = amount(value);
  const number = Number(normalized);
  requireValue(Number.isFinite(number) && amount(String(number)) === normalized, 'Amount cannot round-trip through the CRM numeric wire format');
  return number;
}
