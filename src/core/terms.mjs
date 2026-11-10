import { fields, identifier, instant, list, requireValue, text, zone } from './data.mjs';
import { amount, currencyCode } from './money.mjs';

export function terms(raw) {
  fields(raw, ['kind', 'entity_id', 'amount', 'currency', 'owner', 'statement', 'due', 'conditions'], 'terms');
  requireValue(['crm.amount', 'proposal.sent', 'other'].includes(raw.kind), 'terms.kind is unsupported');
  let due = null;
  if (raw.due != null) {
    fields(raw.due, ['literal', 'resolved', 'precision', 'zone'], 'terms.due');
    requireValue(['instant', 'date', 'unknown'].includes(raw.due.precision), 'terms.due.precision is invalid');
    due = { literal: text(raw.due.literal ?? '', 'terms.due.literal', 500, { empty: true }),
      resolved: raw.due.resolved ?? null, precision: raw.due.precision,
      zone: zone(raw.due.zone ?? null, 'terms.due.zone', { nullable: true }) };
    if (due.precision === 'instant' && due.resolved !== null) {
      requireValue(due.zone !== null, 'terms.due requires an explicit zone');
      due.resolved = instant(due.resolved, 'terms.due.resolved');
    } else if (due.precision === 'instant') {
      // A stated wall time can remain ambiguous; it is not a resolved instant.
    } else if (due.precision === 'date') {
      requireValue(typeof due.resolved === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due.resolved), 'Date-only deadline requires YYYY-MM-DD');
      instant(due.resolved + 'T12:00:00Z', 'terms.due.resolved');
    } else requireValue(due.resolved === null, 'Unresolved deadline must not invent a date');
  }
  const conditions = list(raw.conditions ?? [], 'terms.conditions', 16).map((condition, index) => {
    fields(condition, ['literal', 'status', 'value'], `terms.conditions[${index}]`);
    if ('status' in condition) requireValue(['unknown', 'known', 'satisfied', 'unsatisfied'].includes(condition.status), `condition[${index}].status is invalid`);
    if ('value' in condition) requireValue(typeof condition.value === 'boolean' || condition.value === null, `condition[${index}].value is invalid`);
    if (condition.status === 'known') requireValue(typeof condition.value === 'boolean', `condition[${index}].known requires a boolean value`);
    // Extracted assertions are not manager attestations or external verification.
    return { literal: text(condition.literal, `condition[${index}].literal`, 1000) };
  });
  return { kind: raw.kind, entity_id: identifier(raw.entity_id ?? null, 'terms.entity_id', { nullable: true }),
    amount: raw.amount == null ? null : amount(raw.amount, 'terms.amount'),
    currency: raw.currency == null ? null : currencyCode(raw.currency, 'terms.currency'),
    owner: identifier(raw.owner ?? null, 'terms.owner', { nullable: true }),
    statement: text(raw.statement ?? '', 'terms.statement', 1000, { empty: true }), due, conditions };
}

export function observation(raw) {
  fields(raw, ['schema_version', 'adapter', 'mode', 'origin', 'entity_id', 'amount', 'currency', 'revision',
    'observed_at', 'response_sha256'], 'observation');
  requireValue(raw.schema_version === 1, 'observation.schema_version must be 1');
  const target = adapterTarget({ adapter: raw.adapter, mode: raw.mode, origin: raw.origin });
  requireValue(typeof raw.response_sha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.response_sha256), 'observation.response_sha256 must be SHA256');
  return { schema_version: 1, ...target, entity_id: identifier(raw.entity_id, 'observation.entity_id'),
    amount: amount(raw.amount, 'observation.amount'), currency: currencyCode(raw.currency, 'observation.currency'),
    revision: revisionNumber(raw.revision), observed_at: instant(raw.observed_at, 'observation.observed_at'),
    response_sha256: raw.response_sha256 };
}

export function revisionNumber(value) {
  requireValue(typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)
    && Number.isSafeInteger(Number(value)) && String(Number(value)) === value,
  'observation.revision must be a canonical positive safe-integer string');
  return value;
}

export function adapterTarget(raw) {
  fields(raw, ['adapter', 'mode', 'origin'], 'target');
  requireValue(['demo', 'espocrm'].includes(raw.adapter), 'Unknown target adapter');
  requireValue(raw.mode === (raw.adapter === 'demo' ? 'synthetic' : 'single-writer-sandbox'), 'Target mode does not match its adapter');
  text(raw.origin, 'target.origin', 200);
  let origin = raw.origin;
  if (raw.adapter === 'demo') requireValue(origin === 'demo://crm', 'Demo target must name the synthetic CRM');
  else {
    let url;
    try { url = new URL(origin); } catch { requireValue(false, 'target.origin must be an HTTP(S) origin'); }
    requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash, 'target.origin must contain only an HTTP(S) origin without credentials');
    origin = url.origin;
  }
  return { adapter: raw.adapter, mode: raw.mode, origin };
}

export function targetOf(record) {
  return adapterTarget({ adapter: record.adapter, mode: record.mode, origin: record.origin });
}

export function beforeState(record) {
  return Object.fromEntries(['adapter', 'mode', 'origin', 'entity_id', 'amount', 'currency', 'revision'].map(key => [key, record[key]]));
}
