import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreExtractions } from '../src/evaluation/extraction.mjs';
import { makeSource } from '../src/core/source.mjs';
import { terms } from '../src/core/terms.mjs';
import { resolveDeadline, deadlineUnknowns } from '../src/adapters/deadline.mjs';

function fixture(id = 'A', language = 'en', text = 'Alex will record USD 100 on O1.') {
  return { id, language, sources: [{ id: 'meeting', title: 'Authored scorer test', participants: [{ speaker: 'Alex', person_id: 'alex' }],
    segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 3, text }] }], annotations: [{ id: id + '-gold', source: 'meeting', agreement: 'accepted',
    evidence: [{ segment: 0, quote: text, start: 0, end: text.length }], kind: 'crm.amount', entity_id: 'O1', amount: '100', currency: 'USD', owner: 'alex', due: null, conditions: [], unknown_fields: ['due'] }] };
}
function prediction(f) {
  const g = f.annotations[0];
  return { agreement: g.agreement, evidence: g.evidence.map(({ segment, quote }) => ({ segment, quote, start: null, end: null })),
    terms: { kind: g.kind, entity_id: g.entity_id, amount: g.amount, currency: g.currency, owner: g.owner, statement: 'Authored scorer input, not model output',
      due: g.due === null ? null : { literal: g.due.literal, resolved: null, precision: 'unknown', zone: null }, conditions: g.conditions }, unknown_fields: g.unknown_fields };
}
async function run(f, raw, { elapsed_ms = 10, normalize = null } = {}) {
  const source = await makeSource(f.sources[0]);
  const candidates = raw.map((value, raw_index) => {
    let normalized;
    try {
      const normalizedTerms = terms(value.terms), resolved = resolveDeadline(normalizedTerms.due, source); normalizedTerms.due = resolved.due;
      const unknown = deadlineUnknowns([...value.unknown_fields], resolved);
      for (const field of ['owner', 'entity_id', 'amount', 'currency', 'due']) if (normalizedTerms[field] === null && !unknown.includes(field)) unknown.push(field);
      normalized = { terms: normalizedTerms, unknown_fields: unknown.sort() };
    } catch { normalized = {}; }
    return { raw_index, raw: value, ...normalized, ...(normalize?.(value, raw_index) ?? {}) };
  });
  return { case_id: f.id, source_alias: f.sources[0].id, source_id: source.id, elapsed_ms,
    result: { status: 'complete', source_id: source.id, raw_candidate_count: raw.length, candidates,
      response: { choices: [{ message: { content: JSON.stringify({ candidates: raw }) } }] }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } };
}

test('strict semantic score canonicalizes money/absence and ignores paraphrasable statement', async () => {
  const f = fixture(), p = prediction(f); p.terms.amount = '100.00';
  const report = await scoreExtractions([f], [await run(f, [p])]);
  assert.deepEqual([report.strict.tp, report.strict.fp, report.strict.fn], [1, 0, 0]);
  assert.equal(report.strict.precision, 1); assert.equal(report.strict.recall, 1);
  assert.equal(report.fields.amount.accuracy, 1);
  assert.equal(report.runs[0].predictions[0].raw.terms.amount, '100.00');
  assert.equal(report.cost.amount, null);
});

test('duplicates remain FP and field accuracy also includes non-strict source-aligned records', async () => {
  const f = fixture(), wrong = prediction(f); wrong.terms.amount = '999';
  const report = await scoreExtractions([f], [await run(f, [wrong, prediction(f)])]);
  assert.deepEqual([report.strict.tp, report.strict.fp, report.strict.fn], [1, 1, 0]);
  assert.equal(report.strict.precision, .5);
  assert.equal(report.detection.tp, 1);
  assert.equal(report.runs[0].aligned[0].raw_index, 1);
  assert.equal(report.fields.amount.correct, 1); assert.equal(report.fields.amount.total, 1);
  assert.deepEqual(report.runs[0].unmatched_predictions.map(p => p.raw_index), [0]);
  const onlyWrong = await scoreExtractions([f], [await run(f, [wrong])]);
  assert.equal(onlyWrong.strict.tp, 0); assert.equal(onlyWrong.detection.tp, 1);
  assert.equal(onlyWrong.fields.amount.correct, 0); assert.equal(onlyWrong.fields.amount.total, 1);
});

test('maximum matching reassigns an earlier broad span to retain both distinct gold items', async () => {
  const text = 'First commitment. Second commitment.', f = fixture('M', 'en', text);
  f.annotations[0].evidence = [{ segment: 0, quote: 'First commitment.', start: 0, end: 17 }];
  const second = structuredClone(f.annotations[0]); second.id = 'M-second';
  second.evidence = [{ segment: 0, quote: 'Second commitment.', start: 18, end: 36 }]; f.annotations.push(second);
  const broad = prediction(f); broad.evidence[0].quote = text;
  const report = await scoreExtractions([f], [await run(f, [broad, prediction(f)])]);
  assert.deepEqual([report.strict.tp, report.strict.fp, report.strict.fn], [2, 0, 0]);
  assert.equal(report.detection.tp, 2);
  assert.deepEqual(report.runs[0].strict_matches.map(m => [m.raw_index, m.gold_id]), [[0, 'M-second'], [1, 'M-gold']]);
});

test('null/schema failures/unsupported quotes all retain raw indices and denominators', async () => {
  const f = fixture(), invented = prediction(f), extra = prediction(f);
  invented.evidence[0].quote = 'Invented quotation'; extra.confirmed = true;
  const report = await scoreExtractions([f], [await run(f, [null, invented, extra, prediction(f)])]);
  assert.deepEqual([report.strict.tp, report.strict.fp, report.strict.fn], [1, 3, 0]);
  assert.deepEqual(report.runs[0].predictions.map(p => p.raw_index), [0, 1, 2, 3]);
  assert.equal(report.validity.quotes.known_total, 4); assert.equal(report.validity.quotes.valid, 2);
  assert.equal(report.counts.schema_error_predictions, 2);
  assert.equal(report.runs[0].predictions[0].raw, null);
  assert.equal(report.runs[0].unmatched_predictions.length, 3);
});

test('known failed counts become placeholder FP; unknown failed counts keep precision unknown', async () => {
  const a = fixture('A'), b = fixture('B', 'ru'), good = await run(a, [prediction(a)]), bId = (await makeSource(b.sources[0])).id;
  const failed = { case_id: b.id, source_alias: 'meeting', source_id: bId, elapsed_ms: 30,
    failure: { code: 'incomplete', message: 'Authored transport failure', evidence: { source_id: bId, raw_candidate_count: 2 } } };
  let report = await scoreExtractions([a, b], [good, failed]);
  assert.deepEqual([report.strict.tp, report.strict.fp, report.strict.fn], [1, 2, 1]);
  assert.equal(report.strict.precision, 1 / 3); assert.equal(report.counts.placeholders, 2);
  assert.equal(report.counts.successful_empty, 0); assert.equal(report.by_language.ru.strict.fn, 1);
  delete failed.failure.evidence.raw_candidate_count;
  report = await scoreExtractions([a, b], [good, failed]);
  assert.equal(report.strict.precision, null); assert.equal(report.strict.fp, null);
  assert.equal(report.strict.recall, .5); assert.equal(report.strict.fn, 1);
  assert.equal(report.validity.quotes.rate, null); assert.equal(report.counts.raw_count_unknown_runs, 1);
  assert.equal(report.runs[1].failure.code, 'incomplete');
  failed.failure.evidence.candidates = [{ raw_index: 2, raw: null }];
  report = await scoreExtractions([a, b], [good, failed]);
  assert.equal(report.strict.fp_known_lower_bound, 3); assert.equal(report.strict.precision, null);
  assert.equal(report.counts.placeholders, 2);
});

test('a failed request cannot earn a TP even when its retained partial content looks correct', async () => {
  const f = fixture(), captured = await run(f, [prediction(f)]);
  const failed = { ...captured, failure: { code: 'incomplete', message: 'Did not finish normally', evidence: captured.result } }; delete failed.result;
  const report = await scoreExtractions([f], [failed]);
  assert.deepEqual([report.strict.tp, report.strict.fp, report.strict.fn], [0, 1, 1]);
  assert.equal(report.detection.tp, 0); assert.equal(report.validity.quotes.valid, 1);
});

test('missing/duplicate/cross-source runs and dangling gold fail before any partial score', async () => {
  const f = fixture(), valid = await run(f, [prediction(f)]);
  await assert.rejects(scoreExtractions([f], []), /Missing extraction runs/);
  await assert.rejects(scoreExtractions([f], [valid, valid]), /Duplicate extraction run/);
  await assert.rejects(scoreExtractions([f], [{ ...valid, source_id: 'wrong' }]), /canonical source/);
  const changed = structuredClone(f); changed.sources[0].segments[0].text += ' Edited.';
  await assert.rejects(scoreExtractions([changed], [valid]), /canonical source/);
  const dangling = structuredClone(f); dangling.annotations[0].source = 'absent';
  await assert.rejects(scoreExtractions([dangling], [valid]), /unknown source alias/);
});

test('postprocessed deadline/unknown fields are scored while untouched raw claims remain visible', async () => {
  const f = fixture('D', 'en', 'Alex will record USD 100 on O1 tomorrow at 17:00 Moscow time.'), due = { literal: 'tomorrow at 17:00 Moscow time', resolved: '2030-01-09T14:00:00Z', precision: 'instant', zone: 'Europe/Moscow' };
  f.sources[0].meeting_at = '2030-01-08T09:00:00Z'; f.sources[0].time_zone = 'Europe/Moscow';
  f.annotations[0].due = due; f.annotations[0].unknown_fields = [];
  const raw = prediction(f); raw.terms.due = { literal: due.literal, resolved: null, precision: 'unknown', zone: null }; raw.unknown_fields = ['due.resolved'];
  const captured = await run(f, [raw]);
  const report = await scoreExtractions([f], [captured]);
  assert.equal(report.strict.tp, 1);
  assert.equal(report.runs[0].predictions[0].raw.terms.due.resolved, null);
  assert.equal(report.runs[0].predictions[0].semantic['due.resolved'], '2030-01-09T14:00:00.000Z');
});

test('model-computed deadline fields remain schema-invalid FP even when they copy the correct gold values', async () => {
  const literal = 'by 17:00 London time on 8 January 2030', f = fixture('W', 'en', 'Alex will record USD 100 on O1 ' + literal + '.');
  f.sources[0].meeting_at = '2030-01-08T09:00:00Z'; f.sources[0].time_zone = 'Europe/London';
  f.annotations[0].due = { literal, resolved: '2030-01-08T17:00:00Z', precision: 'instant', zone: 'Europe/London' };
  f.annotations[0].unknown_fields = [];
  const valid = prediction(f);
  const invalid = [{ resolved: f.annotations[0].due.resolved }, { precision: 'instant' }, { zone: 'Europe/London' }]
    .map(change => { const raw = structuredClone(valid); Object.assign(raw.terms.due, change); return raw; });
  const report = await scoreExtractions([f], [await run(f, [...invalid, valid])]);
  assert.deepEqual([report.strict.tp, report.strict.fp, report.strict.fn], [1, 3, 0]);
  assert.equal(report.counts.schema_error_predictions, 3);
  for (const [index, raw] of invalid.entries()) {
    assert.equal(report.runs[0].predictions[index].schema_valid, false);
    assert.deepEqual(report.runs[0].predictions[index].raw, raw);
    assert.ok(report.runs[0].unmatched_predictions.some(item => item.raw_index === index));
  }
  assert.deepEqual(report.runs[0].predictions[3].raw.terms.due, { literal, resolved: null, precision: 'unknown', zone: null });
  assert.equal(report.runs[0].predictions[3].semantic['due.resolved'], '2030-01-08T17:00:00.000Z');
});

test('prerequisite truth claims are separate from literal/strict correctness and confer no authority', async () => {
  const f = fixture(); f.annotations[0].conditions = [{ literal: 'If approved', status: 'known', value: false }];
  const p = prediction(f); p.terms.conditions = [{ literal: 'If approved', status: 'known', value: true }];
  const report = await scoreExtractions([f], [await run(f, [p])]);
  assert.equal(report.strict.tp, 1);
  assert.equal(report.fields['conditions.literals'].accuracy, 1);
  assert.equal(report.fields['conditions.claims'].accuracy, 0);
});

test('valid empty output stays distinct from failure, and latency/usage expose workload and missing values', async () => {
  const fixtures = [fixture('A'), fixture('B', 'ru'), fixture('C')]; fixtures.forEach(f => f.annotations = []);
  const runs = await Promise.all(fixtures.map((f, i) => run(f, [], { elapsed_ms: [10, 30, 20][i] })));
  delete runs[1].result.usage;
  const report = await scoreExtractions(fixtures, runs);
  assert.equal(report.counts.successful_empty, 3); assert.equal(report.counts.failures, 0);
  assert.equal(report.strict.precision, null); assert.equal(report.strict.recall, null);
  assert.equal(report.latency.median, 20); assert.equal(report.latency.p90, 30);
  assert.equal(report.usage.total_tokens.sum_reported, 30); assert.equal(report.usage.total_tokens.complete, false);
  assert.equal(report.workload.sources, 3);
});

test('normalized wrappers cannot repair commercial meaning or remove non-deadline uncertainty', async () => {
  const f = fixture(), bad = prediction(f); bad.terms.amount = '99999';
  const forged = await run(f, [bad], { normalize: () => ({ terms: terms(prediction(f).terms), unknown_fields: ['due'] }) });
  let report = await scoreExtractions([f], [forged]);
  assert.deepEqual([report.strict.tp, report.strict.fp, report.strict.fn], [0, 1, 1]);
  assert.equal(report.fields.amount.accuracy, 0);
  assert.match(report.runs[0].predictions[0].support_errors.join(' '), /deterministic raw\/source pipeline/);
  const uncertain = prediction(f); uncertain.unknown_fields = ['owner', 'due'];
  report = await scoreExtractions([f], [await run(f, [uncertain], { normalize: () => ({ unknown_fields: ['due'] }) })]);
  assert.equal(report.strict.tp, 0);
  const omitted = prediction(f); omitted.unknown_fields = [];
  report = await scoreExtractions([f], [await run(f, [omitted])]);
  assert.equal(report.strict.tp, 1); // Explicit due:null derives the missing due flag without guessing meaning.
});

test('all choices in a nonconforming response remain failed predictions, never a best choice', async () => {
  const f = fixture(), captured = await run(f, [prediction(f)]);
  captured.result.response.choices.push(structuredClone(captured.result.response.choices[0]));
  const report = await scoreExtractions([f], [captured]);
  assert.deepEqual([report.strict.tp, report.strict.fp, report.strict.fn], [0, 2, 1]);
  assert.equal(report.counts.failures, 1); assert.equal(report.runs[0].predictions.length, 2);
  const partial = await run(f, [prediction(f)]);
  partial.result.response.choices.unshift({ message: { content: 'incomplete' } });
  const incomplete = await scoreExtractions([f], [partial]);
  assert.equal(incomplete.strict.tp, 0); assert.equal(incomplete.strict.precision, null);
  assert.equal(incomplete.strict.fp_known_lower_bound, 1); assert.equal(incomplete.strict.fn, 1);
  const wrongRoot = await run(f, [prediction(f)]); wrongRoot.result.response.choices[0].message.content = 'null';
  const invalid = await scoreExtractions([f], [wrongRoot]);
  assert.equal(invalid.strict.tp, 0); assert.equal(invalid.counts.failures, 1);
});
