import { fields, identifier, sha256 } from '../core/data.mjs';
import { amount, currencyCode, wireAmount } from '../core/money.mjs';

const MAX_RESPONSE_BYTES = 65_536;

export class EspoError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'EspoError';
    this.code = code;
    this.status = status;
    this.write_sent = false;
  }
}

function fail(code, message, status) { throw new EspoError(code, message, status); }

function crmOrigin(value) {
  if (typeof value !== 'string' || /[\s\p{Cc}]/u.test(value)) fail('configuration', 'Invalid CRM origin');
  let url;
  try { url = new URL(value); } catch { fail('configuration', 'Invalid CRM origin'); }
  const loopback = /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]';
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port === '0') {
    fail('configuration', 'CRM requires a loopback HTTP or HTTPS origin without credentials, path, query or fragment');
  }
  return url.origin;
}

function key(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value)) {
    fail('configuration', 'A valid private CRM API key is required');
  }
  return value;
}

function revision(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)
      || !Number.isSafeInteger(Number(value)) || String(Number(value)) !== value) {
    fail('invalid_input', 'Expected CRM revision must be a positive canonical safe-integer string');
  }
  return value;
}

function input(action) {
  try { return action(); }
  catch (error) {
    if (error instanceof EspoError) throw error;
    fail('invalid_input', 'Invalid CRM request input');
  }
}

function record(value, entityId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.id !== entityId
      || value.deleted !== false || typeof value.amount !== 'number' || !Number.isFinite(value.amount)
      || !Number.isSafeInteger(value.versionNumber) || value.versionNumber < 1) {
    fail('invalid_response', 'CRM returned an invalid, deleted or mismatched Opportunity');
  }
  let normalizedAmount, currency;
  try { normalizedAmount = amount(String(value.amount)); currency = currencyCode(value.amountCurrency); }
  catch { fail('invalid_response', 'CRM returned unsupported amount or currency data'); }
  // Only selected business attributes enter observations or their digest.
  return { id: entityId, deleted: false, amount: normalizedAmount,
    amountCurrency: currency, versionNumber: String(value.versionNumber) };
}

export class EspoCRM {
  #origin;
  #readKey;
  #writeKey;
  #singleWriter;
  #timeoutMs;
  #updating = false;

  constructor(options) {
    try { fields(options, ['origin', 'readKey', 'writeKey', 'singleWriter', 'timeoutMs'], 'CRM configuration'); }
    catch { fail('configuration', 'Invalid CRM configuration fields'); }
    const { origin, readKey, writeKey, singleWriter = false, timeoutMs = 5000 } = options;
    this.#origin = crmOrigin(origin);
    this.#readKey = key(readKey);
    this.#writeKey = key(writeKey);
    if (readKey === writeKey) fail('configuration', 'Separate reader and writer API keys are required');
    if (typeof singleWriter !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      fail('configuration', 'Invalid single-writer flag or CRM timeout');
    }
    this.#singleWriter = singleWriter;
    this.#timeoutMs = timeoutMs;
  }

  async #request(method, entityId, payload, expectedRevision) {
    const writing = method === 'PUT';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref();
    let response;
    try {
      response = await fetch(`${this.#origin}/api/v1/Opportunity/${encodeURIComponent(entityId)}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', 'X-Api-Key': writing ? this.#writeKey : this.#readKey,
          ...(writing ? { 'Content-Type': 'application/json', 'X-Version-Number': expectedRevision } : {}) },
        ...(writing ? { body: JSON.stringify(payload) } : {}),
      });
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        if ([409, 412].includes(response.status)) fail('conflict', 'CRM refused the conflicting update', response.status);
        if ([401, 403].includes(response.status)) fail('denied', 'CRM denied the request', response.status);
        if (writing && (response.status === 408 || response.status >= 500)) {
          fail('uncertain_outcome', 'CRM write outcome is uncertain; reconcile with a fresh read', response.status);
        }
        fail('http', 'CRM refused the request', response.status);
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
        fail('response_limit', 'CRM response exceeds the supported byte limit');
      }
      if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        fail('invalid_response', 'CRM did not return JSON');
      }
      if (!response.body) fail('invalid_response', 'CRM response body is missing');
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) fail('response_limit', 'CRM response exceeds the supported byte limit');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let parsed;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { fail('invalid_response', 'CRM returned malformed JSON or UTF-8'); }
      return record(parsed, entityId);
    } catch (error) {
      if (writing && !(error instanceof EspoError && ['conflict', 'denied', 'http', 'uncertain_outcome'].includes(error.code))) {
        fail('uncertain_outcome', 'CRM write outcome is uncertain; reconcile with a fresh read');
      }
      if (error instanceof EspoError) throw error;
      fail(controller.signal.aborted ? 'timeout' : 'transport', 'CRM read could not complete');
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  async readOpportunity(entityId) {
    input(() => identifier(entityId, 'Opportunity ID'));
    const observed = await this.#request('GET', entityId);
    return { schema_version: 1, adapter: 'espocrm', mode: 'single-writer-sandbox', origin: this.#origin,
      entity_id: observed.id, amount: observed.amount, currency: observed.amountCurrency,
      revision: observed.versionNumber, observed_at: new Date().toISOString(), response_sha256: await sha256(observed) };
  }

  async updateAmount(options) {
    input(() => fields(options, ['entityId', 'amount', 'currency', 'expectedRevision'], 'CRM update'));
    const entityId = input(() => identifier(options.entityId, 'Opportunity ID'));
    const normalizedAmount = input(() => amount(options.amount));
    const currency = input(() => currencyCode(options.currency));
    const expectedRevision = revision(options.expectedRevision);
    if (!this.#singleWriter) fail('single_writer_required', 'Writes require an explicitly configured single-writer sandbox');
    // This instance rejects overlapping writes; cross-process exclusivity is the caller's responsibility.
    if (this.#updating) fail('busy', 'A CRM update is already in progress');
    this.#updating = true;
    let writeSent = false;
    try {
      const before = await this.readOpportunity(entityId);
      if (before.revision !== expectedRevision) fail('conflict', 'CRM changed since the approved revision');
      const payload = { amount: input(() => wireAmount(normalizedAmount)), amountCurrency: currency };
      writeSent = true;
      const acknowledged = await this.#request('PUT', entityId, payload, expectedRevision);
      if (acknowledged.amount !== normalizedAmount || acknowledged.amountCurrency !== currency) {
        fail('uncertain_outcome', 'CRM acknowledgement differs from the request; reconcile with a fresh read');
      }
      return { schema_version: 1, adapter: 'espocrm', mode: 'single-writer-sandbox', kind: 'write-acknowledgement',
        origin: this.#origin, entity_id: entityId, amount: normalizedAmount, currency,
        expected_revision: expectedRevision, acknowledged_at: new Date().toISOString(), requires_verification: true };
    } catch (error) {
      if (error instanceof EspoError) { error.write_sent = writeSent; throw error; }
      const failure = new EspoError(writeSent ? 'uncertain_outcome' : 'preflight_failed',
        writeSent ? 'CRM write outcome is uncertain; reconcile with a fresh read' : 'The CRM write was not sent because its read preflight failed');
      failure.write_sent = writeSent; throw failure;
    } finally { this.#updating = false; }
  }
}
