import { fields, identifier, instant, integer, jsonData, list, requireValue, sha256 } from '../core/data.mjs';
import { amount, currencyCode } from '../core/money.mjs';

export const DEMO_TARGET = Object.freeze({ adapter: 'demo', mode: 'synthetic', origin: 'demo://crm' });

function row(raw) {
  fields(raw, ['entity_id', 'amount', 'currency', 'revision'], 'Demo CRM record');
  const revision = typeof raw.revision === 'string' && /^[1-9]\d*$/.test(raw.revision) ? Number(raw.revision) : raw.revision;
  integer(revision, 'Demo CRM revision', 1, Number.MAX_SAFE_INTEGER - 1);
  return { entity_id: identifier(raw.entity_id, 'Demo CRM entity'), amount: amount(raw.amount),
    currency: currencyCode(raw.currency), revision };
}

export class DemoCRM {
  #records;
  #ledger;
  #clock;

  constructor({ records = [], ledger = [], clock = () => new Date().toISOString() } = {}) {
    jsonData({ records, ledger });
    this.#records = list(records, 'Demo CRM records', 100).map(row);
    requireValue(new Set(this.#records.map(item => item.entity_id)).size === this.#records.length, 'Duplicate Demo CRM entity');
    this.#ledger = structuredClone(list(ledger, 'Demo CRM ledger', 2000));
    this.#clock = clock;
  }

  snapshot() { return { records: structuredClone(this.#records), ledger: structuredClone(this.#ledger) }; }

  async readOpportunity(entityId) {
    identifier(entityId, 'Demo CRM entity');
    const record = this.#records.find(item => item.entity_id === entityId);
    requireValue(record, 'Demo CRM entity was not found');
    const observed = structuredClone(record);
    return { schema_version: 1, ...DEMO_TARGET, entity_id: observed.entity_id, amount: observed.amount,
      currency: observed.currency, revision: String(observed.revision),
      observed_at: instant(this.#clock(), 'Demo CRM clock'), response_sha256: await sha256(observed) };
  }

  #change(entityId, values, kind, expectedRevision = null) {
    identifier(entityId, 'Demo CRM entity');
    requireValue(this.#ledger.length < 2000, 'Demo CRM ledger is full; export before starting another workspace');
    const index = this.#records.findIndex(item => item.entity_id === entityId);
    requireValue(index >= 0, 'Demo CRM entity was not found');
    const before = structuredClone(this.#records[index]);
    if (expectedRevision !== null) requireValue(String(before.revision) === expectedRevision, 'Demo CRM changed since the approved revision');
    const after = row({ ...before, ...values, revision: before.revision + 1 });
    const at = instant(this.#clock(), 'Demo CRM clock');
    this.#records[index] = after;
    this.#ledger.push({ sequence: this.#ledger.length + 1, kind, at, entity_id: entityId, before, after: structuredClone(after) });
    return after;
  }

  async updateAmount(options) {
    fields(options, ['entityId', 'amount', 'currency', 'expectedRevision'], 'Demo CRM update');
    identifier(options.expectedRevision, 'Demo CRM expected revision');
    const after = this.#change(options.entityId, { amount: amount(options.amount), currency: currencyCode(options.currency) }, 'approved_write', options.expectedRevision);
    return { schema_version: 1, ...DEMO_TARGET, kind: 'write-acknowledgement', entity_id: after.entity_id,
      amount: after.amount, currency: after.currency, acknowledged_at: instant(this.#clock(), 'Demo CRM clock'), requires_verification: true };
  }

  operatorChange(entityId, values) {
    fields(values, ['amount', 'currency'], 'Demo CRM operator edit');
    requireValue(Object.keys(values).length > 0, 'An operator edit requires a changed field');
    const checked = {};
    if ('amount' in values) checked.amount = amount(values.amount);
    if ('currency' in values) checked.currency = currencyCode(values.currency);
    return structuredClone(this.#change(entityId, checked, 'operator_edit'));
  }
}
