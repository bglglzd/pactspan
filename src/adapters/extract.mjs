import { createHash } from 'node:crypto';
import { fields, jsonData, canonical } from '../core/data.mjs';
import { makeSource, citation } from '../core/source.mjs';
import { terms } from '../core/terms.mjs';
import { EXTRACTION_VERSION, EXTRACTION_PROMPT, EXTRACTION_SCHEMA, CANDIDATE_SCHEMA } from './extraction-prompt.mjs';
import { DEADLINE_VERSION, resolveDeadline, deadlineUnknowns } from './deadline.mjs';

const MAX_REQUEST_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 262_144;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');

export class ExtractionError extends Error {
  constructor(code, message, evidence = null) {
    super(message);
    this.name = 'ExtractionError'; this.code = code;
    // Raw data is deliberately retained for PRIVATE evaluation, never in the error message.
    this.evidence = evidence;
  }
}

function fail(code, message, evidence) { throw new ExtractionError(code, message, evidence); }

function configuration(options) {
  try { fields(options, ['origin', 'model', 'timeoutMs', 'maxTokens'], 'extraction options'); }
  catch { fail('configuration', 'Invalid extraction configuration fields'); }
  const { origin, model, timeoutMs = 120_000, maxTokens = 1024 } = options;
  let url;
  try { if (typeof origin !== 'string' || /[\s\p{Cc}?#]/u.test(origin)) throw new Error(); url = new URL(origin); }
  catch { fail('configuration', 'Invalid local model origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || !(/^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]')
      || url.username || url.password || url.pathname !== '/' || url.port === '0') fail('configuration', 'Extraction requires a loopback origin without credentials or paths');
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000
      || !Number.isSafeInteger(maxTokens) || maxTokens < 16 || maxTokens > 2048) fail('configuration', 'Invalid model, timeout or output token bound');
  return { origin: url.origin, model, timeoutMs, maxTokens };
}

export function extractionConfig(options) {
  const config = configuration(options);
  const identity = { version: EXTRACTION_VERSION, ...config, temperature: 0, seed: 42, stream: false,
    chat_template_kwargs: { enable_thinking: false }, max_request_bytes: MAX_REQUEST_BYTES,
    max_response_bytes: MAX_RESPONSE_BYTES, deadline_version: DEADLINE_VERSION, prompt_sha256: hash(EXTRACTION_PROMPT), schema_sha256: hash(EXTRACTION_SCHEMA) };
  return { ...identity, config_sha256: hash(identity) };
}

// This validator covers the constructs of the fixed exported schema, not arbitrary JSON Schema.
function shape(value, schema, path = '$') {
  if (schema.anyOf) return schema.anyOf.some(branch => !shape(value, branch, path).length) ? [] : [path + ': no permitted value type'];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(type) && !(types.includes('integer') && Number.isSafeInteger(value))) return [path + ': invalid type'];
  if (schema.enum && !schema.enum.includes(value)) return [path + ': invalid enum'];
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return [path + ': numeric bound'];
  if (type === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)
      || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)))) return [path + ': invalid text'];
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return [path + ': array bound'];
    return value.flatMap((item, index) => shape(item, schema.items, path + '[' + index + ']'));
  }
  if (type === 'object') {
    const errors = [];
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) errors.push(path + ': unknown fields');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(path + '.' + key + ': missing');
    for (const [key, child] of Object.entries(schema.properties)) if (Object.hasOwn(value, key)) errors.push(...shape(value[key], child, path + '.' + key));
    return errors;
  }
  return [];
}

function normalizeCandidate(raw, rawIndex, source) {
  const diagnostics = [];
  try { jsonData(raw); }
  catch { diagnostics.push({ code: 'schema', message: 'Candidate contains unsupported JSON values, keys or text' }); }
  if (!diagnostics.length) diagnostics.push(...shape(raw, CANDIDATE_SCHEMA).map(message => ({ code: 'schema', message })));
  const result = { raw_index: rawIndex, raw, schema_valid: !diagnostics.length, supported: false,
    support_scope: 'exact-citations-and-terms-shape-only', requires_confirmation: true, diagnostics };
  if (diagnostics.length) return result;
  result.agreement = raw.agreement;
  result.unknown_fields = [...raw.unknown_fields];
  result.evidence = raw.evidence.map(item => {
    try {
      const checked = citation(source, { ...item, source: source.id });
      if (!checked.supported) diagnostics.push({ code: 'unsupported_quote', message: checked.reason });
      return checked;
    } catch {
      diagnostics.push({ code: 'invalid_quote_span', message: 'Citation offsets or quote are outside the supported source bounds' });
      return { ...item, source: source.id, supported: false, reason: 'Invalid exact citation span' };
    }
  });
  try {
    result.terms = terms(raw.terms);
    result.deadline_resolution = resolveDeadline(result.terms.due, source);
    result.terms.due = result.deadline_resolution.due;
    result.unknown_fields = deadlineUnknowns(result.unknown_fields, result.deadline_resolution);
    for (const field of ['owner', 'entity_id', 'amount', 'currency', 'due']) {
      if (result.terms[field] === null && !result.unknown_fields.includes(field)) result.unknown_fields.push(field);
    }
    result.unknown_fields.sort();
    if (result.deadline_resolution.unsupported) diagnostics.push({ code: 'unsupported_deadline', message: result.deadline_resolution.reason });
    if (raw.terms.conditions.some(condition => condition.status === 'unknown' && condition.value !== null)) throw new Error();
  } catch { diagnostics.push({ code: 'invalid_terms', message: 'Candidate terms failed local domain validation' }); }
  if (raw.terms.owner !== null && !source.participants.some(person => person.person_id === raw.terms.owner)) {
    diagnostics.push({ code: 'unmapped_owner', message: 'Predicted owner is absent from the supplied participant mapping' });
  }
  result.supported = !diagnostics.length;
  return result;
}

function countContent(response) {
  try {
    const value = JSON.parse(response?.choices?.[0]?.message?.content);
    return Array.isArray(value?.candidates) ? value.candidates.length : null;
  } catch { return null; }
}

function boundedOutput(value) {
  const pending = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++nodes > 20_000 || depth > 24) return false;
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push([child, depth + 1]);
    }
  }
  return true;
}

export async function extractCandidates(source, options) {
  const config = extractionConfig(options);
  let checked;
  try {
    const copy = structuredClone(source);
    checked = await makeSource(copy);
    if (copy.id !== checked.id) throw new Error();
  } catch { fail('source', 'Extraction requires exactly one canonical source with a matching content identity'); }
  const input = { source_id: checked.id, meeting_at: checked.meeting_at, time_zone: checked.time_zone,
    participants: checked.participants, segments: checked.segments.map((segment, index) => ({ segment: index, ...segment })) };
  const request = { model: config.model, messages: [{ role: 'system', content: EXTRACTION_PROMPT }, { role: 'user', content: JSON.stringify(input) }],
    temperature: 0, seed: 42, max_tokens: config.maxTokens, stream: false, chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_schema', json_schema: { name: 'pactspan_candidates_v1', strict: true, schema: EXTRACTION_SCHEMA } } };
  const requestText = JSON.stringify(request);
  if (Buffer.byteLength(requestText) > MAX_REQUEST_BYTES) fail('request_limit', 'Source exceeds the extraction request byte bound');
  const evidence = { schema_version: 1, adapter: 'openai-compatible-local', source_id: checked.id, config,
    input_sha256: hash(input), request_sha256: hash(requestText), request,
    response: null, response_text: null, response_truncated: false, raw_candidate_count: null,
    started_at: new Date().toISOString() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs); timer.unref();
  let response;
  const chunks = []; let total = 0;
  try {
    response = await fetch(config.origin + '/v1/chat/completions', { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: requestText });
    evidence.http_status = response.status;
    evidence.response_content_type = response.headers.get('content-type');
    const contentLength = response.headers.get('content-length');
    evidence.declared_content_length = contentLength;
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
      evidence.response_truncated = true;
      fail('response_limit', 'Model response exceeds the supported byte bound', evidence);
    }
    if (!response.body) fail('response', 'Model response body is missing', evidence);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        if (total + value.byteLength > MAX_RESPONSE_BYTES) {
          chunks.push(value.subarray(0, MAX_RESPONSE_BYTES - total));
          total += value.byteLength;
          evidence.response_truncated = true; fail('response_limit', 'Model response exceeds the supported byte bound', evidence);
        }
        total += value.byteLength; chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, total);
    evidence.response_sha256 = createHash('sha256').update(bytes).digest('hex');
    try { evidence.response_text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); evidence.response = JSON.parse(evidence.response_text); }
    catch { evidence.response_bytes_base64 = bytes.toString('base64'); fail('response', 'Model returned malformed JSON or UTF-8', evidence); }
    evidence.raw_candidate_count = countContent(evidence.response);
    if (response.status !== 200) fail('http', 'Local model refused the request', evidence);
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(evidence.response_content_type ?? '')) fail('response', 'Model did not return a JSON media type', evidence);
    const envelope = evidence.response;
    if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object') fail('response', 'Model envelope must be an object', evidence);
    try { jsonData(envelope); } catch { fail('response', 'Model envelope exceeds supported JSON shape limits', evidence); }
    evidence.actual_model = envelope.model ?? null;
    evidence.usage = envelope.usage ?? null;
    if (envelope.model !== config.model || !Array.isArray(envelope.choices) || envelope.choices.length !== 1) fail('identity', 'Model response identity or choice count differs from the requested profile', evidence);
    const choice = envelope.choices[0];
    if (!choice || Array.isArray(choice) || typeof choice !== 'object' || !choice.message || Array.isArray(choice.message)
        || typeof choice.message !== 'object' || choice.message.role !== 'assistant') fail('response', 'Model choice or assistant message is invalid', evidence);
    evidence.finish_reason = choice.finish_reason;
    if (choice.message?.refusal || choice.finish_reason === 'content_filter') fail('refusal', 'Model refused extraction', evidence);
    if (choice.finish_reason !== 'stop') fail('incomplete', 'Model extraction did not finish normally', evidence);
    if (choice.message?.reasoning_content || typeof choice.message?.content !== 'string') fail('response', 'Model returned reasoning or missing candidate content', evidence);
    let parsed;
    try { parsed = JSON.parse(choice.message.content); }
    catch { fail('output_json', 'Candidate content is not a complete supported JSON document', evidence); }
    if (!boundedOutput(parsed)) fail('output_limit', 'Candidate output exceeds global node or depth bounds', evidence);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length !== 1
        || !Array.isArray(parsed.candidates) || parsed.candidates.length > 32) fail('schema', 'Candidate root violates the fixed output schema', evidence);
    const candidates = parsed.candidates.map((candidate, index) => normalizeCandidate(candidate, index, checked));
    return { ...evidence, status: candidates.every(candidate => candidate.schema_valid) ? 'complete' : 'invalid_output',
      raw_candidate_count: parsed.candidates.length, candidates, completed_at: new Date().toISOString(),
      authority: 'unconfirmed-model-predictions', semantic_correctness_verified: false };
  } catch (error) {
    evidence.completed_at = new Date().toISOString();
    if (chunks.length && evidence.response_text === null && !evidence.response_bytes_base64) {
      evidence.response_bytes_base64 = Buffer.concat(chunks).toString('base64');
      evidence.response_truncated = true;
      evidence.response_bytes_read = total;
    }
    if (error instanceof ExtractionError) throw error;
    fail(controller.signal.aborted ? 'timeout' : 'transport', 'Local extraction request could not complete', evidence);
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
