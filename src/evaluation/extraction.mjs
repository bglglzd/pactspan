import { CANDIDATE_SCHEMA, EXTRACTION_VERSION } from '../adapters/extraction-prompt.mjs';
import { makeSource, citation } from '../core/source.mjs';
import { terms } from '../core/terms.mjs';
import { amount } from '../core/money.mjs';
import { DEADLINE_VERSION, resolveDeadline, deadlineUnknowns } from '../adapters/deadline.mjs';
import { jsonData, requireValue, sha256 } from '../core/data.mjs';

const PRIMARY = ['agreement', 'kind', 'entity_id', 'amount', 'currency', 'owner', 'due.literal', 'due.resolved', 'due.precision', 'due.zone', 'conditions.literals', 'unknown_fields'];
const FIELDS = [...PRIMARY, 'conditions.claims'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const absent = () => ({ missing_or_invalid: true });
const copy = value => value === undefined ? absent() : structuredClone(value);
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
}
const equal = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const ratio = (n, d) => d ? n / d : null;

function schemaErrors(value, schema, at = '$') {
  if (schema.anyOf) return schema.anyOf.some(branch => !schemaErrors(value, branch, at).length) ? [] : [at + ': no permitted type'];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes(type) && !(types.includes('integer') && Number.isSafeInteger(value))) return [at + ': invalid type'];
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(at + ': invalid enum');
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) errors.push(at + ': invalid number');
  if (type === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)
    || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)))) errors.push(at + ': invalid text');
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) errors.push(at + ': invalid array length');
    value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, `${at}[${index}]`)));
  }
  if (type === 'object') {
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) errors.push(at + '.' + key + ': unknown field');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(at + '.' + key + ': missing');
    for (const [key, child] of Object.entries(schema.properties)) if (Object.hasOwn(value, key)) errors.push(...schemaErrors(value[key], child, at + '.' + key));
  }
  return errors;
}

function textField(value, nullable = false) { return typeof value === 'string' || (nullable && value === null) ? value : absent(); }
function normalizedAmount(value) { try { return value === null ? null : amount(value); } catch { return absent(); } }
function deadline(value) {
  if (value === null) return { literal: null, resolved: null, precision: 'unknown', zone: null };
  if (!object(value)) return Object.fromEntries(['literal', 'resolved', 'precision', 'zone'].map(key => [key, absent()]));
  let resolved = value.resolved;
  if (value.precision === 'instant' && typeof resolved === 'string' && Number.isFinite(Date.parse(resolved))) resolved = new Date(resolved).toISOString();
  return { literal: value.literal === '' || value.literal === null ? null : textField(value.literal), resolved: textField(resolved, true),
    precision: textField(value.precision), zone: textField(value.zone, true) };
}
function strings(value, unique = false) {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return absent();
  return (unique ? [...new Set(value)] : [...value]).sort();
}
function claims(value) {
  if (!Array.isArray(value)) return absent();
  return value.map(item => ({ literal: textField(item?.literal), status: textField(item?.status),
    value: item?.value === undefined && item?.status === 'unknown' ? null : typeof item?.value === 'boolean' || item?.value === null ? item.value : absent() }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function semantic(raw, normalized) {
  const value = object(normalized?.terms) ? normalized.terms : raw?.terms;
  const due = deadline(value?.due);
  const unknown = Array.isArray(normalized?.unknown_fields) ? normalized.unknown_fields : raw?.unknown_fields;
  return { agreement: textField(raw?.agreement), kind: textField(value?.kind), entity_id: textField(value?.entity_id, true),
    amount: normalizedAmount(value?.amount), currency: textField(value?.currency, true), owner: textField(value?.owner, true),
    ...Object.fromEntries(Object.entries(due).map(([key, item]) => ['due.' + key, item])),
    'conditions.literals': strings(Array.isArray(value?.conditions) ? value.conditions.map(item => item?.literal) : null),
    unknown_fields: strings(unknown, true), 'conditions.claims': claims(raw?.terms?.conditions) };
}
function goldSemantic(annotation) {
  return semantic({ agreement: annotation.agreement, terms: annotation, unknown_fields: annotation.unknown_fields }, null);
}

function inventory(payload) {
  const errors = [];
  let envelope = payload?.response;
  if (!envelope && typeof payload?.response_text === 'string') { try { envelope = JSON.parse(payload.response_text); } catch { errors.push('response_text is not a complete JSON envelope'); } }
  let parsed, authoritative = null, unknownChoices = false;
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    try { parsed = JSON.parse(content); } catch { errors.push('candidate content is not complete JSON'); }
    if (object(parsed) && Array.isArray(parsed.candidates)) authoritative = parsed.candidates;
  }
  if (Array.isArray(envelope?.choices) && envelope.choices.length !== 1) {
    errors.push('exactly one model choice is required; no best-of-N choice is selected');
    const arrays = envelope.choices.map(choice => { try { const value = JSON.parse(choice?.message?.content); return Array.isArray(value?.candidates) ? value.candidates : null; } catch { return null; } });
    authoritative = arrays.filter(Boolean).flat();
    unknownChoices = arrays.some(value => value === null);
  }
  const declared = Number.isSafeInteger(payload?.raw_candidate_count) && payload.raw_candidate_count >= 0 ? payload.raw_candidate_count : null;
  const wrappers = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const indexed = new Map();
  for (const [position, wrapper] of wrappers.entries()) {
    const index = Number.isSafeInteger(wrapper?.raw_index) && wrapper.raw_index >= 0 ? wrapper.raw_index : position;
    requireValue(!indexed.has(index), 'Duplicate raw_index in extraction artifact; cannot choose a best prediction');
    indexed.set(index, { wrapper, metadata_valid: Number.isSafeInteger(wrapper?.raw_index) && wrapper.raw_index >= 0 });
  }
  const count = unknownChoices ? null : authoritative?.length ?? declared;
  requireValue(count === null || count <= 65_536, 'Captured raw prediction count exceeds the adapter response bound; evaluation is not scored');
  if (count !== null) requireValue([...indexed.keys()].every(index => index < count), 'Raw index lies outside the captured raw prediction count');
  if (authoritative && declared !== null && declared !== authoritative.length) errors.push('raw_candidate_count differs from raw response array');
  if (authoritative && (Object.keys(parsed).length !== 1 || authoritative.length > 32)) errors.push('raw response root violates the extraction schema');
  const knownFloor = Math.max(authoritative?.length ?? 0, ...[...indexed.keys()].map(index => index + 1), 0);
  requireValue(knownFloor <= 65_536, 'Raw index exceeds the captured adapter output bound; evaluation is not scored');
  const indices = Array.from({ length: count ?? knownFloor }, (_, i) => i);
  const rows = indices.map(index => {
    const entry = indexed.get(index), raw = authoritative ? authoritative[index] : entry?.wrapper?.raw;
    if (authoritative && entry?.wrapper && Object.hasOwn(entry.wrapper, 'raw')) requireValue(equal(raw, entry.wrapper.raw), 'Indexed raw record differs from the retained response content');
    return { raw_index: index, raw: copy(raw), placeholder: raw === undefined,
      normalized: entry?.metadata_valid ? entry.wrapper : null, metadata_valid: Boolean(entry?.metadata_valid) };
  });
  return { count, known_count: rows.length, rows, errors, raw_response_available: Boolean(authoritative), placeholder_count: rows.filter(row => row.placeholder).length };
}

function inspect(row, source) {
  const raw = row.placeholder ? undefined : row.raw, errors = [];
  try { jsonData(raw); } catch { errors.push('raw prediction is not supported JSON data'); }
  if (!errors.length) errors.push(...schemaErrors(raw, CANDIDATE_SCHEMA));
  const schemaValid = errors.length === 0, spans = [], quoteErrors = [];
  const evidence = Array.isArray(raw?.evidence) ? raw.evidence : [];
  let sourceValid = evidence.length > 0;
  const rootSourceWrong = (raw?.source_id !== undefined && raw.source_id !== source.id) || (raw?.source !== undefined && raw.source !== source.id);
  if (rootSourceWrong) sourceValid = false;
  for (const [index, item] of evidence.entries()) {
    if (rootSourceWrong || !object(item) || (item.source !== undefined && item.source !== source.id) || (item.source_id !== undefined && item.source_id !== source.id)) {
      sourceValid = false; quoteErrors.push({ evidence_index: index, error: 'citation source differs from the bound source' }); continue;
    }
    try {
      const span = Object.fromEntries(['segment', 'quote', 'start', 'end'].filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
      const checked = citation(source, { ...span, source: source.id });
      if (checked.supported) spans.push({ source: source.id, segment: checked.segment, start: checked.start, end: checked.end, quote: checked.quote });
      else quoteErrors.push({ evidence_index: index, error: checked.reason });
      if (!source.segments[item.segment]) sourceValid = false;
    } catch (error) { quoteErrors.push({ evidence_index: index, error: error.message }); if (!source.segments[item.segment]) sourceValid = false; }
  }
  const supportErrors = [];
  if (!row.metadata_valid || !row.normalized || !Object.hasOwn(row.normalized, 'terms') || !Object.hasOwn(row.normalized, 'unknown_fields')) supportErrors.push('complete indexed normalized record is missing');
  let pipeline = null;
  if (schemaValid) {
    try {
      const normalizedTerms = terms(raw.terms), resolution = resolveDeadline(normalizedTerms.due, source);
      normalizedTerms.due = resolution.due;
      const unknown = deadlineUnknowns([...raw.unknown_fields], resolution);
      for (const field of ['owner', 'entity_id', 'amount', 'currency', 'due']) if (normalizedTerms[field] === null && !unknown.includes(field)) unknown.push(field);
      unknown.sort();
      pipeline = { terms: normalizedTerms, unknown_fields: unknown };
      if (!equal(row.normalized?.terms, normalizedTerms) || !equal(row.normalized?.unknown_fields, unknown)) supportErrors.push('normalized record differs from deterministic raw/source pipeline');
      if (resolution.unsupported) supportErrors.push(resolution.reason);
    } catch (error) { supportErrors.push(error.message); }
  }
  if (Array.isArray(raw?.terms?.conditions)) for (const condition of raw.terms.conditions) {
    if ((condition?.status === 'known' && typeof condition.value !== 'boolean') || (condition?.status === 'unknown' && condition.value !== null)) supportErrors.push('condition status/value claim is incoherent');
  }
  if (raw?.terms?.owner !== null && raw?.terms?.owner !== undefined && !source.participants.some(p => p.person_id === raw.terms.owner)) supportErrors.push('predicted owner is not in the supplied mapping');
  if (!Array.isArray(row.normalized?.unknown_fields) || !row.normalized.unknown_fields.every(item => typeof item === 'string')) supportErrors.push('normalized unknown_fields is invalid');
  return { raw_index: row.raw_index, raw: row.raw, placeholder: row.placeholder, schema_valid: schemaValid,
    source_valid: sourceValid, quote_valid: evidence.length > 0 && !quoteErrors.length && sourceValid,
    spans, schema_errors: errors, support_errors: supportErrors, quote_errors: quoteErrors,
    supported: schemaValid && evidence.length > 0 && !quoteErrors.length && sourceValid && !supportErrors.length,
    semantic: semantic(raw, pipeline), normalized_terms: copy(row.normalized?.terms), normalized_unknown_fields: copy(row.normalized?.unknown_fields),
    recomputed_pipeline_terms: copy(pipeline?.terms), recomputed_pipeline_unknown_fields: copy(pipeline?.unknown_fields) };
}

const overlaps = (a, b) => a.source === b.source && a.segment === b.segment && Math.max(a.start, b.start) < Math.min(a.end, b.end);
function maximumMatching(edges, goldCount) {
  const owners = Array(goldCount).fill(-1);
  function visit(prediction, seen) {
    for (const gold of edges[prediction]) {
      if (seen.has(gold)) continue;
      seen.add(gold);
      if (owners[gold] === -1 || visit(owners[gold], seen)) { owners[gold] = prediction; return true; }
    }
    return false;
  }
  edges.forEach((_, prediction) => visit(prediction, new Set()));
  return owners.flatMap((prediction, gold) => prediction < 0 ? [] : [{ prediction, gold }]).sort((a,b) => a.prediction-b.prediction);
}
function alignedMatching(edges, goldCount, preferred) {
  const n = edges.length, start = n + goldCount, end = start + 1, graph = Array.from({ length: end + 1 }, () => []);
  function add(from, to, cost, gold = null) {
    const forward = { to, cost, cap: 1, reverse: graph[to].length, gold };
    graph[from].push(forward); graph[to].push({ to: from, cost: -cost, cap: 0, reverse: graph[from].length - 1, gold: null });
  }
  edges.forEach((options, prediction) => { add(start, prediction, 0); for (const gold of options) add(prediction, n + gold, preferred[prediction].includes(gold) ? -1 : 0, gold); });
  for (let gold = 0; gold < goldCount; gold++) add(n + gold, end, 0);
  // Successive shortest augmenting paths maximize cardinality first, then the
  // number of exact-field pairs. Traversal order resolves any remaining tie.
  for (;;) {
    const distance = Array(graph.length).fill(Infinity), previous = Array(graph.length).fill(null); distance[start] = 0;
    for (let round = 0; round < graph.length - 1; round++) {
      let changed = false;
      for (let node = 0; node < graph.length; node++) for (const [index, edge] of graph[node].entries()) {
        if (edge.cap && distance[node] + edge.cost < distance[edge.to]) { distance[edge.to] = distance[node] + edge.cost; previous[edge.to] = [node, index]; changed = true; }
      }
      if (!changed) break;
    }
    if (!previous[end]) break;
    for (let node = end; node !== start;) { const [from, index] = previous[node], edge = graph[from][index]; edge.cap--; graph[node][edge.reverse].cap++; node = from; }
  }
  return edges.flatMap((_, prediction) => graph[prediction].filter(edge => edge.gold !== null && edge.cap === 0).map(edge => ({ prediction, gold: edge.gold })));
}
function metrics(tp, gold, known, unknown) {
  return { tp, fp: unknown ? null : known - tp, fp_known_lower_bound: known - tp, fn: gold - tp, gold,
    predictions: unknown ? null : known, known_predictions: known, denominator_complete: !unknown,
    precision: unknown ? null : ratio(tp, known), recall: ratio(tp, gold),
    precision_upper_bound_from_known_rows: unknown ? ratio(tp, known) : null };
}
function fieldSummary(aligned) {
  return Object.fromEntries(FIELDS.map(field => {
    const correct = aligned.filter(pair => pair.fields[field].correct).length;
    return [field, { correct, total: aligned.length, accuracy: ratio(correct, aligned.length) }];
  }));
}
function latency(runs) {
  const values = runs.map(run => run.elapsed_ms).filter(value => Number.isFinite(value) && value >= 0).sort((a,b) => a-b), n = values.length;
  return { unit: 'ms', measured: n, missing: runs.length-n, median: n ? n % 2 ? values[(n-1)/2] : (values[n/2-1]+values[n/2])/2 : null,
    p90: n ? values[Math.ceil(n*.9)-1] : null, p90_method: 'nearest rank', sum_observed_ms: n ? values.reduce((a,b) => a+b, 0) : null };
}
function aggregate(runs) {
  const known = runs.reduce((n,r) => n+r.known_predictions, 0), unknown = runs.filter(r => r.raw_candidate_count === null).length;
  const gold = runs.reduce((n,r) => n+r.gold.length, 0), pairs = runs.flatMap(r => r.aligned);
  const validity = {};
  for (const [name, field] of [['schema', 'schema_valid'], ['source', 'source_valid'], ['quotes', 'quote_valid'], ['support', 'supported']]) {
    const valid = runs.flatMap(r => r.predictions).filter(p => p[field]).length;
    validity[name] = { valid, invalid_known: known-valid, known_total: known, denominator_complete: !unknown, rate: unknown ? null : ratio(valid, known) };
  }
  return { strict: metrics(runs.reduce((n,r) => n+r.strict_matches.length, 0), gold, known, unknown),
    detection: metrics(pairs.length, gold, known, unknown), fields: fieldSummary(pairs), validity,
    alignment: { records: pairs.length, gold, coverage: ratio(pairs.length, gold), source_ambiguous_pairs: pairs.filter(p => p.source_alignment_choices.length > 1).length },
    counts: { runs: runs.length, successful: runs.filter(r => !r.failure).length, failures: runs.filter(r => r.failure).length,
      successful_empty: runs.filter(r => !r.failure && r.raw_candidate_count === 0).length,
      abstentions: runs.filter(r => !r.failure && r.raw_candidate_count === 0).length,
      raw_count_unknown_runs: unknown, placeholders: runs.reduce((n,r) => n+r.placeholder_count, 0),
      schema_error_predictions: runs.flatMap(r => r.predictions).filter(p => p.schema_errors.length).length,
      unsupported_predictions: runs.flatMap(r => r.predictions).filter(p => !p.supported).length }, latency: latency(runs) };
}

/** Score complete retained adapter artifacts. This function never calls an extractor or forwards gold. */
export async function scoreExtractions(fixtures, runs) {
  requireValue(Array.isArray(fixtures) && Array.isArray(runs), 'fixtures and runs must be arrays');
  requireValue(new Set(fixtures.map(f => f.id)).size === fixtures.length, 'Duplicate fixture case ID');
  const bindings = new Map();
  for (const fixture of fixtures) {
    requireValue(Array.isArray(fixture.sources) && Array.isArray(fixture.annotations), 'Each fixture requires sources and annotations');
    requireValue(new Set(fixture.sources.map(s => s.id)).size === fixture.sources.length, 'Duplicate source alias in fixture');
    requireValue(new Set(fixture.annotations.map(a => a.id)).size === fixture.annotations.length, 'Duplicate gold annotation ID');
    requireValue(fixture.annotations.every(a => fixture.sources.some(s => s.id === a.source)), 'Gold annotation refers to an unknown source alias');
    for (const raw of fixture.sources) {
      const source = await makeSource(raw), key = JSON.stringify([fixture.id, raw.id]);
      const gold = fixture.annotations.filter(annotation => annotation.source === raw.id).map(annotation => {
        const spans = annotation.evidence.map(item => citation(source, { source: source.id, ...item }));
        requireValue(spans.length > 0 && spans.every(span => span.supported), 'Gold contains unsupported source evidence');
        return { id: annotation.id, semantic: goldSemantic(annotation), spans, raw: annotation };
      });
      bindings.set(key, { fixture, alias: raw.id, source, gold });
    }
  }
  const seen = new Set(), reports = [];
  for (const [runIndex, run] of runs.entries()) {
    requireValue(object(run), 'Each extraction run must be an object');
    const key = JSON.stringify([run.case_id, run.source_alias]), binding = bindings.get(key);
    requireValue(binding, `Run ${runIndex} names an unknown case/source binding`);
    requireValue(!seen.has(key), 'Duplicate extraction run for a fixture source; best-of-N is not scored');
    seen.add(key);
    requireValue(run.source_id === binding.source.id, `Run ${runIndex} source_id does not match canonical source content`);
    requireValue(Object.hasOwn(run, 'result') !== Object.hasOwn(run, 'failure'), 'Each run requires exactly one result or failure');
    const failure = Object.hasOwn(run, 'failure'), payload = failure ? run.failure?.evidence ?? run.failure : run.result;
    requireValue(object(payload), 'Extraction result/failure evidence must be an object');
    if (payload.source_id !== undefined) requireValue(payload.source_id === binding.source.id, 'Result/failure evidence source binding differs');
    const raw = inventory(payload), predictions = raw.rows.map(row => inspect(row, binding.source));
    const outputErrors = [...raw.errors];
    if (!failure && !['complete', 'invalid_output'].includes(payload.status)) outputErrors.push('result has no supported completed adapter status');
    const failed = failure || outputErrors.length > 0;
    const alignEdges = predictions.map(p => failed ? [] : binding.gold.flatMap((g, i) => p.spans.some(span => g.spans.some(gold => overlaps(span, gold))) ? [i] : []));
    const strictEdges = alignEdges.map((edges, i) => predictions[i].supported ? edges.filter(g => PRIMARY.every(field => equal(predictions[i].semantic[field], binding.gold[g].semantic[field]))) : []);
    const alignedIndices = alignedMatching(alignEdges, binding.gold.length, strictEdges), strictIndices = maximumMatching(strictEdges, binding.gold.length);
    const aligned = alignedIndices.map(({ prediction, gold }) => ({ run_index: runIndex, raw_index: predictions[prediction].raw_index, gold_id: binding.gold[gold].id,
      source_alignment_choices: alignEdges[prediction].map(g => binding.gold[g].id),
      fields: Object.fromEntries(FIELDS.map(field => [field, { expected: binding.gold[gold].semantic[field], actual: predictions[prediction].semantic[field], correct: equal(binding.gold[gold].semantic[field], predictions[prediction].semantic[field]) }])) }));
    const strictMatches = strictIndices.map(({ prediction, gold }) => ({ run_index: runIndex, raw_index: predictions[prediction].raw_index, gold_id: binding.gold[gold].id }));
    const matchedPredictions = new Set(strictMatches.map(m => m.raw_index)), matchedGold = new Set(strictMatches.map(m => m.gold_id));
    reports.push({ run_index: runIndex, case_id: run.case_id, language: binding.fixture.language, source_alias: run.source_alias, source_id: binding.source.id,
      elapsed_ms: Number.isFinite(run.elapsed_ms) && run.elapsed_ms >= 0 ? run.elapsed_ms : null,
      raw_candidate_count: raw.count, known_predictions: raw.known_count, placeholder_count: raw.placeholder_count, raw_response_available: raw.raw_response_available,
      failure: failed ? { code: failure ? run.failure.code ?? 'failure' : 'invalid_artifact', message: failure ? run.failure.message ?? 'Extraction failed' : 'Retained output is not a valid completed artifact', output_errors: outputErrors } : null,
      predictions, gold: binding.gold, strict_matches: strictMatches, aligned,
      unmatched_gold: binding.gold.filter(g => !matchedGold.has(g.id)).map(g => g.id),
      unmatched_predictions: predictions.flatMap((p, index) => matchedPredictions.has(p.raw_index) ? [] : [{ raw_index: p.raw_index, placeholder: p.placeholder,
        reason: failed ? 'source_run_failed' : !p.schema_valid ? 'schema_invalid' : !p.supported ? 'unsupported' : strictEdges[index].length ? 'one_to_one_duplicate' : 'semantic_or_detection_mismatch',
        schema_errors: p.schema_errors, support_errors: p.support_errors, quote_errors: p.quote_errors,
        source_aligned_gold: alignEdges[index].map(gold => ({ gold_id: binding.gold[gold].id, differences: PRIMARY.filter(field => !equal(p.semantic[field], binding.gold[gold].semantic[field])) })) }]),
      usage: copy(payload.usage ?? null), pipeline: { actual_model: payload.actual_model ?? null, config_sha256: payload.config?.config_sha256 ?? null, postprocessor: payload.postprocessor ?? null } });
  }
  requireValue(seen.size === bindings.size, 'Missing extraction runs: exactly one run is required for every supplied fixture source');
  const summary = aggregate(reports), languages = [...new Set(fixtures.map(f => f.language))].sort();
  const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(key => {
    const values = reports.map(r => r.usage?.[key]), valid = values.filter(v => Number.isSafeInteger(v) && v >= 0);
    return [key, { sum_reported: valid.length ? valid.reduce((a,b) => a+b, 0) : null, runs_reported: valid.length, runs_missing: reports.length-valid.length, complete: valid.length === reports.length }];
  }));
  return { schema_version: 1, protocol: 'pactspan-extraction-score-v1', extraction_schema_version: EXTRACTION_VERSION, deadline_version: DEADLINE_VERSION,
    matcher: { strict: 'maximum one-to-one exact-field and exact-source-overlap matching', detection: 'maximum source-overlap cardinality',
      alignment_ties: 'maximize strict-compatible pairs without reducing detection cardinality, then stable raw-index/gold-order traversal' },
    candidate_schema_sha256: await sha256(CANDIDATE_SCHEMA), scope: 'Supplied complete raw artifacts and normalized pipeline records; no model invocation or human study',
    ...summary, by_language: Object.fromEntries(languages.map(language => [language, aggregate(reports.filter(r => r.language === language))])),
    workload: { cases: fixtures.length, sources: bindings.size, segments: [...bindings.values()].reduce((n,b) => n+b.source.segments.length, 0),
      utf16_units: [...bindings.values()].reduce((n,b) => n+b.source.segments.reduce((m,s) => m+s.text.length, 0), 0),
      utf8_bytes: [...bindings.values()].reduce((n,b) => n+b.source.segments.reduce((m,s) => m+new TextEncoder().encode(s.text).length, 0), 0) },
    usage, cost: { amount: null, currency: null, scope: 'No pricing, electricity, hardware amortization or zero-cost claim; usage is model-reported only' }, runs: reports,
    limitations: ['Strict matching requires exact source overlap and all declared primary fields; citation validity alone is not semantic accuracy.',
      'Detection alignment uses source spans only; field accuracy covers every aligned record, including strict errors.',
      'Normalized pipeline due/unknown fields are scored after postprocessing; raw schema/citations/condition claims remain separate.',
      'Unknown failure counts keep primary FP/precision unknown; known failure rows/placeholders are false positives and gold remains false negative.',
      'No best-of-N, hidden filtering, confidence cutoff, human correction credit or evaluation threshold is applied.'] };
}
