import { Pactspan, invariantErrors } from '../core/engine.mjs';
import { DemoCRM, DEMO_TARGET } from '../adapters/demo.mjs';
import { canonical, instant, jsonData, requireValue } from '../core/data.mjs';

const clone = value => value === undefined ? { missing: true } : structuredClone(value);
const equal = (a, b) => canonical(clone(a)) === canonical(clone(b));
const termKeys = ['kind', 'entity_id', 'amount', 'currency', 'owner', 'due', 'conditions'];

class JourneyError extends Error {
  constructor(code, message, status = 'refused') { super(message); this.name = 'JourneyError'; this.code = code; this.status = status; }
}

function assertion(rows, name, expected, actual) {
  rows.push({ name, expected: clone(expected), actual: clone(actual), pass: equal(expected, actual) });
}

function refusals(reason, actual) {
  const message = actual.error?.message ?? actual.reasons?.join('; ') ?? '';
  const code = actual.error?.code;
  const rules = {
    owner_unknown: /Owner requires clarification/,
    owner_and_agreement_unresolved: /Owner requires clarification|Ambiguous agreement/,
    amendment_not_accepted: /Ambiguous agreement requires an explicit manager reason/,
    condition_not_met: /Condition requires a manager decision/,
    not_confirmed: /Unknown commitment version|no confirmed version/i,
    superseded_version: /not current|obsolete|superseded/i,
    unresolved_term_conflict: /Conflicting confirmed terms|not current/,
    amount_mismatch: /Observed CRM fields differ/,
    entity_mismatch: /Receipt entity differs/,
    unsupported_proposal_sent_predicate: /no supported fulfillment predicate/,
    quote_not_in_source: /Quote is absent|Quote differs/,
    altered_quote: /Quote is absent|Quote differs/,
    approval_expired: /Approval is expired/,
    approval_already_consumed: /reconciliation_required/,
    reconcile_uncertain_attempt_before_retry: /reconciliation_required|requires reconciliation/,
    explicit_confirmed_replacement_required: /confirmation.actor/,
    counteroffer_refused: /Unknown candidate/,
    no_confirmed_commitment: /Unknown approval/,
    no_specific_agreed_action: /Unknown approval/,
    source_text_cannot_authorize_transition: /Unknown approval/,
    draft_is_not_sent: /observation contains unknown fields/,
    superseded_version_receipt: /observation contains unknown fields|not current/,
    ambiguous_local_time: /deadline_unresolved/
  };
  return code === reason || Boolean(rules[reason]?.test(message));
}

function stateOf(ctx, annotationId) {
  const candidateId = ctx.candidates.get(annotationId);
  const state = ctx.app.snapshot(), candidate = state.candidates[candidateId];
  if (!candidate) return { state: 'absent', version_id: null, number: null, next_version_preview: null };
  const record = state.versions[candidate.version_id];
  const group = Object.values(state.commitments).find(item => {
    const current = state.versions[item.current];
    return current?.terms.kind === candidate.terms.kind && current?.terms.entity_id === candidate.terms.entity_id
      && equal(current.target, DEMO_TARGET);
  });
  return { candidate_id: candidate.id, state: record?.status ?? (candidate.supported ? candidate.state : 'unsupported'),
    version_id: record?.id ?? null, number: record?.number ?? null,
    next_version_preview: record ? null : (group?.versions.length ?? 0) + 1 };
}

async function importSource(ctx, id, propose = true) {
  const raw = ctx.fixture.sources.find(item => item.id === id);
  if (!raw) throw new JourneyError('source_missing', `Unknown authored source: ${id}`, 'blocked');
  const result = await ctx.app.importSource(raw);
  ctx.sources.set(id, result.source.id);
  if (propose) for (const annotation of ctx.fixture.annotations.filter(item => item.source === id)) await ensureCandidate(ctx, annotation.id);
  return result;
}

async function ensureCandidate(ctx, id) {
  if (ctx.candidates.has(id)) return ctx.app.snapshot().candidates[ctx.candidates.get(id)];
  const annotation = ctx.fixture.annotations.find(item => item.id === id);
  if (!annotation) throw new JourneyError('annotation_missing', `Unknown authored annotation: ${id}`, 'blocked');
  if (!ctx.sources.has(annotation.source)) await importSource(ctx, annotation.source, false);
  const terms = Object.fromEntries(termKeys.map(key => [key, clone(annotation[key])]));
  // Gold condition truth is not a manager attestation. Only the sourced literal enters the core.
  terms.conditions = (annotation.conditions ?? []).map(item => ({ literal: item.literal }));
  const raw = { agreement: annotation.agreement, terms, unknown_fields: annotation.unknown_fields,
    evidence: annotation.evidence.map(item => ({ source: ctx.sources.get(annotation.source), ...item })) };
  const result = await ctx.app.propose(raw);
  ctx.candidates.set(id, result.candidate.id);
  return result.candidate;
}

async function versionId(ctx, id) {
  const candidate = await ensureCandidate(ctx, id);
  // A valid candidate identifier which is not a version makes the core refuse an unconfirmed request.
  return candidate.version_id ?? candidate.id;
}

function snapshot(ctx) { return { domain: ctx.app.snapshot(), external: ctx.crm.snapshot(), clock: ctx.now }; }
function externalRows(ctx) { return ctx.crm.snapshot().records; }
function errorData(error) { return { name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}) }; }

async function operate(ctx, step, calls) {
  const invoke = async (method, input, callback) => {
    const item = { method, input: clone(input) }; calls.push(item);
    try { const output = await callback(); item.output = clone(output); return output; }
    catch (error) { item.error = errorData(error); throw error; }
  };
  const read = entity => invoke('DemoCRM.readOpportunity', { entity_id: entity }, () => ctx.crm.readOpportunity(entity));
  const vid = () => versionId(ctx, step.annotation);
  switch (step.action) {
    case 'import_source': {
      const result = await invoke('Pactspan.importSource + authored proposals', { source: step.source }, () => importSource(ctx, step.source));
      return { result, source_annotations: ctx.fixture.annotations.filter(a => a.source === step.source).map(a => a.id) };
    }
    case 'confirm':
    case 'confirm_replacement': {
      const candidate = await ensureCandidate(ctx, step.annotation);
      const options = { actor: step.actor, target: DEMO_TARGET };
      if (step.action === 'confirm_replacement') options.replaces = await versionId(ctx, step.supersedes);
      return { result: await invoke('Pactspan.confirm', { candidate_id: candidate.id, options }, () => ctx.app.confirm(candidate.id, options)) };
    }
    case 'observe_crm':
    case 'verify_fresh_read': {
      if (step.role && step.role !== 'reader') throw new JourneyError('reader_role_unsupported', 'Verification requires the explicit synthetic reader role', 'unimplemented');
      if (step.outcome === 'unavailable') throw new JourneyError('verification_unavailable', 'Authored reader outage: no observation or fulfillment is manufactured');
      const candidate = await ensureCandidate(ctx, step.annotation);
      const observed = await read(step.observation?.entity_id ?? candidate.terms.entity_id);
      const result = await invoke('Pactspan.verify', { version_id: await vid(), observed }, async () => ctx.app.verify(await vid(), observed));
      return { observed, result, guarded: !result.matched, reasons: result.reasons ?? [] };
    }
    case 'approve_action': {
      const id = await vid(), candidate = await ensureCandidate(ctx, step.annotation);
      const requested = Object.fromEntries(['entity_id', 'amount', 'currency'].filter(key => key in step).map(key => [key, step[key]]));
      if (Object.keys(requested).some(key => requested[key] !== candidate.terms[key])) {
        calls.push({ method: 'journey approval-scope boundary', input: { requested, actual_terms: candidate.terms }, origin: 'driver, not a core API method' });
        throw new JourneyError('requested_terms_mismatch', 'Requested approval scope differs from the actual candidate terms');
      }
      const observed = await read(step.entity_id ?? candidate.terms.entity_id);
      const options = { actor: step.actor ?? 'manager', expires_at: step.expires_at ?? new Date(Date.parse(ctx.now) + 15 * 60_000).toISOString() };
      const result = await invoke('Pactspan.approve', { version_id: id, observed, options }, () => ctx.app.approve(id, observed, options));
      if (step.approval_id) ctx.approvals.set(step.approval_id, result.id);
      return { result, observed };
    }
    case 'execute_action':
    case 'repeat_approval': {
      if (step.outcome && !['acknowledged', 'timeout_after_write'].includes(step.outcome)) throw new JourneyError('outcome_unimplemented', `Unsupported injected write outcome: ${step.outcome}`, 'unimplemented');
      const approvalId = ctx.approvals.get(step.approval_id);
      if (!approvalId) throw new JourneyError('approval_reference_missing', `Prior action did not create approval ${step.approval_id}`, 'blocked');
      const approval = ctx.app.snapshot().approvals[approvalId];
      if (step.annotation && approval.version_id !== await vid()) throw new JourneyError('approval_version_mismatch', 'Approval belongs to another annotated term version');
      if (step.payload && !equal(step.payload, { entity_id: approval.before.entity_id, ...approval.payload })) {
        calls.push({ method: 'journey command-scope boundary', input: { requested: step.payload, approved: { entity_id: approval.before.entity_id, ...approval.payload } }, origin: 'driver, not a core API method' });
        throw new JourneyError('approved_payload_mismatch', 'Requested payload differs from the actual stored approval; no command is sent');
      }
      const observed = await read(approval.before.entity_id);
      const started = await invoke('Pactspan.beginAttempt', { approval_id: approvalId, observed }, () => ctx.app.beginAttempt(approvalId, observed));
      if (!started.command) return { result: started, refused: true, reasons: ['reconciliation_required'] };
      if (step.attempt_id) ctx.attempts.set(step.attempt_id, started.attempt.id);
      const persistedBeforeSend = JSON.parse(JSON.stringify(ctx.app.snapshot()));
      requireValue(Boolean(persistedBeforeSend.attempts[started.attempt.id]), 'Attempt was not present before the external write');
      if (step.persist_before_send) ctx.app = await invoke('Pactspan.restore before send', { attempt_id: started.attempt.id }, () => Pactspan.restore(persistedBeforeSend, { clock: () => ctx.now }));
      // Keep the actual engine object out of the serializable call log.
      if (step.persist_before_send) calls.at(-1).output = { restored_attempt: ctx.app.snapshot().attempts[started.attempt.id] };
      const ack = await invoke('DemoCRM.updateAmount', started.command, () => ctx.crm.updateAmount(started.command));
      const timeout = step.outcome === 'timeout_after_write';
      const recorded = await invoke('Pactspan.finishAttempt', { attempt_id: started.attempt.id, outcome: timeout ? 'uncertain' : 'acknowledged' }, () => ctx.app.finishAttempt(started.attempt.id, { outcome: timeout ? 'uncertain' : 'acknowledged', reason: timeout ? 'Authored timeout after the actual Demo CRM write committed' : '' }));
      return { result: started, ack, recorded, persisted_before_send: persistedBeforeSend.attempts[started.attempt.id], injected_fault: timeout ? 'timeout_after_write' : null };
    }
    case 'external_crm_change':
      return { result: await invoke('DemoCRM.operatorChange', { entity_id: step.entity_id, amount: step.amount, currency: step.currency }, () => ctx.crm.operatorChange(step.entity_id, { amount: step.amount, currency: step.currency })) };
    case 'restart': {
      const saved = JSON.parse(JSON.stringify(snapshot(ctx)));
      ctx.app = await Pactspan.restore(saved.domain, { clock: () => ctx.now });
      ctx.crm = new DemoCRM({ ...saved.external, clock: () => ctx.now });
      calls.push({ method: 'JSON serialize + Pactspan.restore + DemoCRM constructor', input: saved, output: snapshot(ctx) });
      return { serialized_roundtrip: equal(saved, snapshot(ctx)), retained_attempt: step.retained_attempt_id ? ctx.app.snapshot().attempts[ctx.attempts.get(step.retained_attempt_id)] ?? null : null };
    }
    case 'advance_time': return { result: await invoke('Pactspan.checkDeadlines', { now: ctx.now }, () => ctx.app.checkDeadlines()) };
    case 'resolve_deadline': {
      const candidate = await ensureCandidate(ctx, step.annotation);
      const due = clone(candidate.terms.due);
      calls.push({ method: 'manual-gold deadline preservation check', input: { annotation: step.annotation }, output: due, automatic_resolution: false });
      const source = ctx.app.snapshot().sources[ctx.sources.get(ctx.fixture.annotations.find(a => a.id === step.annotation).source)];
      return { due, source_context: { meeting_at: source.meeting_at, time_zone: source.time_zone }, refused: due?.resolved === null, reasons: due?.resolved === null ? ['deadline_unresolved'] : [], automatic_resolution: false };
    }
    case 'submit_candidate': {
      if (!ctx.sources.has(step.source)) await importSource(ctx, step.source, false);
      const template = ctx.fixture.annotations.find(a => a.source === step.source);
      if (!template) throw new JourneyError('probe_terms_missing', 'An authored invalid-quote probe needs explicit manual terms', 'unimplemented');
      const terms = Object.fromEntries(termKeys.map(key => [key, clone(template[key])])); terms.conditions = (template.conditions ?? []).map(c => ({ literal: c.literal }));
      const raw = { agreement: template.agreement, terms, unknown_fields: template.unknown_fields,
        evidence: [{ source: ctx.sources.get(step.source), segment: step.segment, quote: step.quote }] };
      const result = await invoke('Pactspan.propose invalid-quote probe', raw, () => ctx.app.propose(raw));
      ctx.probes.push(result.candidate.id);
      return { candidate: result.candidate, refused: !result.candidate.supported, reasons: result.candidate.support_errors };
    }
    case 'attempt_confirmation': {
      if (!ctx.sources.has(step.source)) await importSource(ctx, step.source);
      const id = ctx.sources.get(step.source);
      return { result: await invoke('Pactspan.confirm source ID without a candidate', { candidate_id: id, actor: 'manager', target: DEMO_TARGET }, () => ctx.app.confirm(id, { actor: 'manager', target: DEMO_TARGET })) };
    }
    case 'attempt_action':
    case 'attempt_action_from_source_instruction': {
      if (step.source && !ctx.sources.has(step.source)) await importSource(ctx, step.source);
      const id = (step.source && ctx.sources.get(step.source)) || ctx.sources.values().next().value || 'no_approval';
      const observed = await read(step.entity_id ?? externalRows(ctx)[0]?.entity_id);
      return { result: await invoke('Pactspan.beginAttempt source ID without approval', { approval_id: id, observed }, () => ctx.app.beginAttempt(id, observed)) };
    }
    case 'attempt_automatic_supersession': {
      const candidate = await ensureCandidate(ctx, step.annotation);
      const replaces = await versionId(ctx, step.supersedes);
      return { result: await invoke('Pactspan.confirm without manager actor', { candidate_id: candidate.id, replaces, target: DEMO_TARGET }, () => ctx.app.confirm(candidate.id, { replaces, target: DEMO_TARGET })) };
    }
    case 'offer_evidence':
    case 'offer_receipt': {
      const raw = step.action === 'offer_receipt' ? clone(step.receipt) : { kind: step.evidence_kind, entity_id: step.entity_id };
      return { result: await invoke('Pactspan.verify rejects untrusted supplied evidence shape', { version_id: await vid(), supplied: raw }, async () => ctx.app.verify(await vid(), raw)) };
    }
    default: throw new JourneyError('action_unimplemented', `Unimplemented journey action: ${step.action}`, 'unimplemented');
  }
}

function actualStepState(ctx, step, operation) {
  if (step.annotation) return stateOf(ctx, step.annotation).state;
  if (operation.candidate) return operation.candidate.supported ? operation.candidate.state : 'unsupported';
  const ids = operation.source_annotations ?? (step.source ? ctx.fixture.annotations.filter(a => a.source === step.source).map(a => a.id) : [...ctx.candidates.keys()]);
  const state = ctx.app.snapshot();
  const fallback = Object.values(state.candidates).map(candidate => state.versions[candidate.version_id]?.status
    ?? (candidate.supported ? candidate.state : 'unsupported'));
  const states = [...new Set(ids.length ? ids.map(id => stateOf(ctx, id).state) : [...fallback, ...Object.values(state.versions).map(record => record.status)])];
  return states.length === 1 ? states[0] : states.length ? 'mixed' : 'no_commitment';
}

function checkStep(ctx, step, operation, rows) {
  if (step.refusal_reason) {
    assertion(rows, 'action refused', true, operation.refused === true || operation.guarded === true || Boolean(operation.error));
    assertion(rows, `refusal guard (${step.refusal_reason})`, true, operation.status !== 'blocked' && operation.status !== 'unimplemented' && refusals(step.refusal_reason, operation));
  } else assertion(rows, 'action completed', true, !operation.error && !operation.refused);
  if (step.expected_state) assertion(rows, 'lifecycle', step.expected_state, actualStepState(ctx, step, operation));
  if (step.annotation && step.version !== undefined) {
    const value = stateOf(ctx, step.annotation);
    assertion(rows, value.number === null ? 'next version preview (not allocated)' : 'allocated version number', step.version, value.number ?? value.next_version_preview);
  }
  if (step.replaced_state) assertion(rows, 'replaced lifecycle', step.replaced_state, stateOf(ctx, step.supersedes).state);
  if (step.expected_source_count !== undefined) assertion(rows, 'source count', step.expected_source_count, Object.keys(ctx.app.snapshot().sources).length);
  if (step.observation && operation.observed) for (const key of ['entity_id', 'amount', 'currency', 'revision']) assertion(rows, 'actual reader ' + key, String(step.observation[key]), String(operation.observed[key]));
  if (step.before_revision !== undefined && operation.observed) assertion(rows, 'actual approval before revision', String(step.before_revision), operation.observed.revision);
  if (step.result_revision !== undefined) assertion(rows, 'actual committed revision', step.result_revision, externalRows(ctx).find(r => r.entity_id === (step.entity_id ?? operation.ack?.entity_id))?.revision);
  if (step.action === 'external_crm_change' && step.revision !== undefined) assertion(rows, 'actual external revision', step.revision, externalRows(ctx).find(r => r.entity_id === step.entity_id)?.revision);
  if (step.external_state) assertion(rows, 'actual timeout-after-write state', step.external_state, externalRows(ctx).find(r => r.entity_id === step.external_state.entity_id));
  if (step.resolved !== undefined) assertion(rows, 'retained manual deadline (not inferred)', instant(step.resolved, 'declared deadline'), operation.due?.resolved);
  if (step.meeting_at) assertion(rows, 'supplied meeting anchor', instant(step.meeting_at, 'declared meeting'), operation.source_context?.meeting_at);
  if (step.time_zone) assertion(rows, 'supplied meeting zone', step.time_zone, operation.source_context?.time_zone);
  if (step.retained_unknowns) {
    const record = ctx.app.snapshot().versions[stateOf(ctx, step.annotation).version_id];
    const candidate = ctx.app.snapshot().candidates[ctx.candidates.get(step.annotation)];
    assertion(rows, 'retained unresolved fields', step.retained_unknowns, step.retained_unknowns.filter(f => candidate?.unknown_fields.includes(f) && !record?.confirmation.resolved_unknowns.includes(f)));
  }
  if (step.retained_attempt_id) assertion(rows, 'attempt survives restart', true, Boolean(operation.retained_attempt));
  if (step.on_time_proven !== undefined) assertion(rows, 'on-time proof', step.on_time_proven, operation.result?.receipt?.deadline_observation === 'observed_by_deadline');
  assertion(rows, 'core invariants', [], invariantErrors(ctx.app.snapshot()));
}

function finalChecks(ctx) {
  const expected = ctx.fixture.expected, state = ctx.app.snapshot(), rows = [], external = ctx.crm.snapshot();
  const states = ctx.fixture.annotations.map(annotation => ({ annotation: annotation.id, ...stateOf(ctx, annotation.id) }));
  for (const annotation of ctx.fixture.annotations) {
    const candidate = state.candidates[ctx.candidates.get(annotation.id)];
    for (const field of ['kind', 'entity_id', 'amount', 'currency', 'owner']) assertion(rows, `${annotation.id} retained ${field}`, annotation[field], candidate?.terms[field]);
    assertion(rows, `${annotation.id} retained agreement`, annotation.agreement, candidate?.agreement);
    assertion(rows, `${annotation.id} exact gold evidence supported`, true, candidate?.supported);
    const due = clone(annotation.due);
    if (due !== null) due.literal ??= ''; // The core represents an absent deadline literal as empty text.
    if (due?.precision === 'instant' && due.resolved !== null) due.resolved = new Date(due.resolved).toISOString();
    assertion(rows, `${annotation.id} retained manual deadline`, due, candidate?.terms.due);
    assertion(rows, `${annotation.id} retained prerequisite literals`, annotation.conditions.map(c => c.literal), candidate?.terms.conditions.map(c => c.literal));
    assertion(rows, `${annotation.id} retained declared unknowns`, annotation.unknown_fields, annotation.unknown_fields.filter(field => candidate?.unknown_fields.includes(field)));
  }
  assertion(rows, 'all allocated versions have annotation bindings', Object.keys(state.versions).sort(), states.map(item => item.version_id).filter(Boolean).sort());
  assertion(rows, 'allocated version count', (expected.commitments ?? []).filter(item => !['proposed', 'unsupported', 'no_commitment'].includes(item.state)).length, Object.keys(state.versions).length);
  assertion(rows, 'no untracked candidates', [...new Set([...ctx.candidates.values(), ...ctx.probes])].sort(), Object.keys(state.candidates).sort());
  for (const wanted of expected.commitments ?? []) {
    const actual = states.find(item => item.annotation === wanted.annotation);
    assertion(rows, `${wanted.annotation} lifecycle`, wanted.state, actual?.state);
    assertion(rows, `${wanted.annotation} version${actual?.number === null ? ' preview' : ''}`, wanted.version, actual?.number ?? actual?.next_version_preview);
    assertion(rows, `${wanted.annotation} logical receipt binding`, wanted.receipt_count, Object.values(state.receipts).some(receipt => receipt.version_id === actual?.version_id) ? 1 : 0);
  }
  if (expected.crm) assertion(rows, 'external final business state', [...expected.crm].sort((a,b) => a.entity_id.localeCompare(b.entity_id)), [...external.records].sort((a,b) => a.entity_id.localeCompare(b.entity_id)));
  const counts = { logical_writes: external.ledger.filter(item => item.kind === 'approved_write').length,
    logical_fulfillments: state.events.filter(item => item.action === 'fulfilled').length,
    persisted_attempts: Object.keys(state.attempts).length, source_count: Object.keys(state.sources).length,
    unsupported_candidate_probes: ctx.probes.filter(id => state.candidates[id]?.supported === false).length };
  for (const key of Object.keys(counts)) if (expected[key] !== undefined) assertion(rows, key, expected[key], counts[key]);
  const badReceipts = Object.values(state.receipts).filter(receipt => {
    const record = state.versions[receipt.version_id], observed = receipt.observation;
    return !record || record.terms.kind !== 'crm.amount' || receipt.terms_hash !== record.terms_hash
      || observed.entity_id !== record.terms.entity_id || observed.amount !== record.terms.amount || observed.currency !== record.terms.currency
      || !equal({ adapter: observed.adapter, mode: observed.mode, origin: observed.origin }, record.target)
      || record.terms.conditions.some((_, index) => receipt.condition_decisions?.[index]?.satisfied !== true);
  });
  const missingReceipts = Object.values(state.versions).filter(v => v.status === 'fulfilled' && !state.receipts[v.fulfillment_receipt]);
  counts.wrong_fulfillments = badReceipts.length + missingReceipts.length;
  if (expected.wrong_fulfillments !== undefined) assertion(rows, 'wrong fulfillments', expected.wrong_fulfillments, counts.wrong_fulfillments);
  const historyNames = { overdue: 'overdue_without_receipt', fulfilled: 'fulfilled', disputed: 'external_state_disputed', superseded: 'superseded' };
  for (const required of expected.retained_history ?? []) {
    const [annotation, status] = required.split(':');
    assertion(rows, 'retained history ' + required, true, state.events.some(event => event.target === stateOf(ctx, annotation).version_id && event.action === historyNames[status]));
  }
  if (expected.retained_receipt_revision !== undefined) assertion(rows, 'prior receipt revision retained', true, Object.values(state.receipts).some(r => r.observation.revision === String(expected.retained_receipt_revision)));
  if (expected.on_time_proven !== undefined) assertion(rows, 'on-time proof', expected.on_time_proven, Object.values(state.receipts).some(r => r.deadline_observation === 'observed_by_deadline'));
  if (expected.forbidden_inferences) for (const annotation of ctx.fixture.annotations) {
    const candidate = state.candidates[ctx.candidates.get(annotation.id)];
    if (annotation.due?.resolved === null || annotation.due?.precision === 'date') assertion(rows, 'no invented deadline for ' + annotation.id, annotation.due, candidate?.terms.due);
  }
  const handled = new Set(['commitments', 'crm', 'wrong_fulfillments', 'logical_writes', 'logical_fulfillments', 'persisted_attempts', 'source_count', 'unsupported_candidate_probes',
    'retained_history', 'retained_receipt_revision', 'on_time_proven', 'forbidden_inferences', 'reason']);
  assertion(rows, 'no unimplemented final oracle fields', [], Object.keys(expected).filter(key => !handled.has(key)));
  assertion(rows, 'core invariants', [], invariantErrors(state));
  return { assertions: rows, counts, annotations: states, domain: state, external };
}

/** Execute authored manual candidates and workflow actions, not automatic extraction. */
export async function runJourney(fixture) {
  jsonData(fixture);
  fixture = structuredClone(fixture);
  requireValue(fixture.schema_version === 1 && Array.isArray(fixture.sources) && Array.isArray(fixture.annotations)
    && Array.isArray(fixture.journey) && fixture.expected, 'Expected an authored schema_version1 development case');
  const anchors = [...fixture.sources.map(item => item.meeting_at), ...fixture.journey.flatMap(item => [item.at, item.observed_at, item.now])].filter(Boolean).map(value => instant(value, 'journey time')).sort();
  const ctx = { fixture, now: anchors[0] ?? '2030-01-01T00:00:00.000Z', sources: new Map(), candidates: new Map(), approvals: new Map(), attempts: new Map(), probes: [] };
  ctx.app = new Pactspan(undefined, { clock: () => ctx.now }); ctx.crm = new DemoCRM({ records: fixture.crm_initial, clock: () => ctx.now });
  const steps = [];
  for (const [index, input] of fixture.journey.entries()) {
    const entry = { index, input: clone(input), calls: [], before: snapshot(ctx), assertions: [] };
    let operation;
    try {
      const at = input.at ?? input.observed_at ?? input.now;
      if (at) { const next = instant(at, 'journey step time'); requireValue(next >= ctx.now, 'Journey time cannot move backwards'); ctx.now = next; }
      operation = { status: 'completed', ...await operate(ctx, input, entry.calls) };
      if (operation.refused) operation.status = 'refused';
    } catch (error) { operation = { status: error.status ?? 'refused', error: errorData(error) }; }
    entry.operation = clone(operation); entry.after = snapshot(ctx);
    checkStep(ctx, input, operation, entry.assertions);
    entry.pass = entry.assertions.every(row => row.pass) && !['blocked', 'unimplemented'].includes(operation.status);
    steps.push(entry);
  }
  const final = finalChecks(ctx);
  return { schema_version: 1, kind: 'authored-gold-development-journey', case_id: fixture.id, language: fixture.language,
    automatic_extraction: false, pass: steps.every(step => step.pass) && final.assertions.every(row => row.pass), steps, final,
    aliases: { sources: Object.fromEntries(ctx.sources), candidates: Object.fromEntries(ctx.candidates), approvals: Object.fromEntries(ctx.approvals), attempts: Object.fromEntries(ctx.attempts) },
    limitations: ['Manual gold supplies candidates; this is not model precision/recall or semantic extraction evidence.',
      'Deadline actions check preservation of supplied manual resolved/unknown values, not natural-language date resolution.',
      'Source-only negatives exercise missing candidate/approval guards; refusal-language classification is not evaluated.',
      'Changed-payload refusal is enforced by this driver against the actual core approval, not a new core method.',
      'Restart and persist-before-send use JSON serialization and async restore in memory, not a filesystem crash test.',
      'Authored reader outage/timeout faults are injected explicitly; all available reads and committed writes use the actual DemoCRM.'] };
}

export async function runJourneys(fixtures) {
  requireValue(Array.isArray(fixtures) && new Set(fixtures.map(fixture => fixture.id)).size === fixtures.length, 'Expected unique authored case IDs');
  const results = [];
  for (const fixture of fixtures) results.push(await runJourney(fixture));
  return { schema_version: 1, kind: 'authored-gold-development-journeys', automatic_extraction: false,
    pass: results.every(result => result.pass), results };
}
