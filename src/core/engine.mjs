import { InputError, canonical, fields, identifier, instant, integer, jsonData, list, requireValue, sha256, text } from './data.mjs';
import { makeSource, citation } from './source.mjs';
import { adapterTarget, beforeState, observation, targetOf, terms } from './terms.mjs';

export function emptyState() {
  return { schema_version: 1, sources: {}, candidates: {}, commitments: {}, versions: {}, approvals: {}, attempts: {}, receipts: {}, observations: {}, events: [] };
}

const RESTORED = Symbol('validated workspace');
const MAX_UNKNOWNS = 32; // Includes locally derived flags beyond the wire model's16-field limit.

function event(state, at, action, target, detail) {
  state.events.push({ sequence: state.events.length + 1, at, action, target, detail: structuredClone(detail) });
}

function version(state, id) {
  identifier(id, 'version ID');
  requireValue(Object.hasOwn(state.versions, id), 'Unknown commitment version');
  return state.versions[id];
}

function invalidateApprovals(state, id, reason) {
  for (const approval of Object.values(state.approvals)) {
    if (approval.version_id === id && approval.state === 'approved') {
      approval.state = 'invalidated'; approval.invalidated_reason = reason;
    }
  }
}

function executionReasons(state, record) {
  const reasons = [];
  if (!record.confirmation) reasons.push('Manager confirmation is required');
  if (state.commitments[record.commitment_id]?.current !== record.id || record.status === 'superseded') reasons.push('This version is not current');
  if (record.dispute_kind === 'terms_conflict') reasons.push('Conflicting confirmed terms require an explicit resolution');
  if (record.terms.kind !== 'crm.amount') reasons.push('This promise has no supported fulfillment predicate');
  for (const field of ['owner', 'entity_id', 'amount', 'currency']) if (record.terms[field] === null) reasons.push(`Required field is unknown: ${field}`);
  const candidate = state.candidates[record.candidate_id];
  for (const field of ['owner', 'entity_id', 'amount', 'currency']) {
    if (candidate.unknown_fields.includes(field) && !record.confirmation.resolved_unknowns.includes(field)) reasons.push(`Uncertainty needs a manager clarification: ${field}`);
  }
  record.terms.conditions.forEach((condition, index) => {
    if (record.condition_decisions[index]?.satisfied !== true) reasons.push(`Condition requires a manager decision: ${condition.literal}`);
  });
  return reasons;
}

function deadlineKnown(state, record) {
  return record.terms.due?.precision === 'instant' && record.terms.due.resolved !== null
    && state.candidates[record.candidate_id].unknown_fields.filter(field => field === 'due' || field.startsWith('due.'))
      .every(field => record.confirmation.resolved_unknowns.includes(field));
}

function unresolvedAttempts(state, record) {
  return Object.values(state.attempts).filter(attempt => {
    const previous = state.versions[attempt.version_id];
    return attempt.outcome !== 'rejected' && !attempt.reconciliation && previous
      && previous.terms.entity_id === record.terms.entity_id && canonical(previous.target) === canonical(record.target);
  });
}

async function acceptObservation(state, observed) {
  const key = 'obs_' + await sha256({ target: targetOf(observed), entity_id: observed.entity_id });
  const previous = state.observations[key];
  if (previous) {
    requireValue(Number(observed.revision) >= Number(previous.revision)
      && Date.parse(observed.observed_at) >= Date.parse(previous.observed_at), 'Stale observation cannot replace newer CRM evidence');
    requireValue(observed.revision !== previous.revision || (observed.amount === previous.amount && observed.currency === previous.currency),
      'CRM observations disagree on business fields for the same revision');
  }
  state.observations[key] = structuredClone(observed);
}

function reconcile(state, attempt, observed, at) {
  const record = version(state, attempt.version_id);
  requireValue(canonical(targetOf(observed)) === canonical(record.target) && observed.entity_id === record.terms.entity_id,
    'Reconciliation observation names another CRM or entity');
  requireValue(Date.parse(observed.observed_at) >= Date.parse(attempt.created_at), 'Reconciliation requires an observation after the attempt began');
  const matched = observed.amount === record.terms.amount && observed.currency === record.terms.currency;
  attempt.last_reconciliation = { matched, observation: structuredClone(observed), at };
  // A nonmatch cannot prove that an uncertain request will never commit later.
  if (matched || attempt.outcome === 'acknowledged' || attempt.outcome === 'rejected') {
    attempt.reconciliation ??= structuredClone(attempt.last_reconciliation);
  }
  event(state, at, 'attempt_reconciled', attempt.id, { matched, outcome_resolved: Boolean(attempt.reconciliation), observation: observed });
  return { matched, resolved: Boolean(attempt.reconciliation), attempt };
}

export function invariantErrors(state) {
  const errors = [];
  for (const group of Object.values(state.commitments)) {
    if (!group.versions.every(id => state.versions[id]?.commitment_id === group.id)) errors.push('Commitment version references are invalid');
    if (!group.versions.includes(group.current)) errors.push('Current commitment version is absent');
  }
  for (const record of Object.values(state.versions)) {
    if (!state.candidates[record.candidate_id] || !record.confirmation) errors.push('Version has no candidate or manager confirmation');
    if (canonical(record.terms) !== canonical(state.candidates[record.candidate_id]?.terms ?? null)) errors.push('Version terms differ from the confirmed candidate');
    if (!['confirmed', 'superseded', 'fulfilled', 'disputed', 'overdue'].includes(record.status)) errors.push('Unknown version state');
    if (['confirmed', 'fulfilled', 'overdue'].includes(record.status)
      && state.commitments[record.commitment_id]?.current !== record.id) errors.push('A noncurrent version has an active state');
    if (record.status === 'fulfilled') {
      const receipt = state.receipts[record.fulfillment_receipt];
      if (!receipt || receipt.version_id !== record.id || receipt.terms_hash !== record.terms_hash
        || receipt.observation.entity_id !== record.terms.entity_id || receipt.observation.amount !== record.terms.amount
        || receipt.observation.currency !== record.terms.currency
        || canonical(targetOf(receipt.observation)) !== canonical(record.target)) errors.push('Fulfillment lacks a matching receipt');
      if (executionReasons(state, record).length) errors.push('Fulfilled version has unresolved execution guards');
    }
    if (record.supersedes) {
      const previous = state.versions[record.supersedes];
      if (!previous || previous.commitment_id !== record.commitment_id || previous.number >= record.number) errors.push('Invalid supersession edge');
    }
  }
  return errors;
}

export class Pactspan {
  #state;
  #clock;
  #queue = Promise.resolve();

  constructor(snapshot = emptyState(), { clock = () => new Date().toISOString() } = {}, restoredToken = null) {
    jsonData(snapshot);
    fields(snapshot, Object.keys(emptyState()), 'workspace');
    requireValue(snapshot.schema_version === 1, 'workspace.schema_version must be 1');
    for (const key of Object.keys(emptyState()).filter(key => !['schema_version', 'events'].includes(key))) {
      requireValue(snapshot[key] !== null && typeof snapshot[key] === 'object' && !Array.isArray(snapshot[key]), `workspace.${key} must be an object`);
    }
    list(snapshot.events, 'workspace.events', 5000);
    requireValue(restoredToken === RESTORED || (snapshot.events.length === 0
      && Object.keys(emptyState()).filter(key => !['schema_version', 'events'].includes(key)).every(key => Object.keys(snapshot[key]).length === 0)),
    'Use await Pactspan.restore(snapshot) for a saved workspace');
    let errors;
    try { errors = invariantErrors(snapshot); }
    catch { requireValue(false, 'Workspace has an invalid record shape'); }
    requireValue(!errors.length, errors.join('; '));
    this.#state = structuredClone(snapshot); this.#clock = clock;
  }

  static async restore(snapshot, options = {}) {
    const restored = new Pactspan(snapshot, options, RESTORED);
    try { await validateIntegrity(restored.#state); }
    catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError('Saved workspace contains an invalid record shape or integrity binding');
    }
    return restored;
  }

  snapshot() { return structuredClone(this.#state); }
  now() { return instant(this.#clock(), 'clock'); }
  view(id) {
    const record = version(this.#state, id);
    const pending = unresolvedAttempts(this.#state, record);
    return { ...structuredClone(record), execution_reasons: [...executionReasons(this.#state, record),
      ...(pending.length ? ['A prior write outcome requires reconciliation'] : [])],
    unresolved_attempts: pending.map(item => ({ id: item.id, version_id: item.version_id, outcome: item.outcome })) };
  }

  #change(callback) {
    const pending = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
      const result = await callback(draft, this.now());
      jsonData(draft);
      const errors = invariantErrors(draft);
      requireValue(!errors.length, errors.join('; '));
      this.#state = draft;
      return structuredClone(result);
    });
    this.#queue = pending.catch(() => {});
    return pending;
  }

  importSource(document) {
    return this.#change(async (state, at) => {
      const source = await makeSource(document);
      if (state.sources[source.id]) return { source: state.sources[source.id], duplicate: true };
      state.sources[source.id] = source;
      event(state, at, 'source_imported', source.id, { title: source.title });
      return { source, duplicate: false };
    });
  }

  propose(raw) {
    return this.#change(async (state, at) => {
      jsonData(raw);
      fields(raw, ['agreement', 'terms', 'evidence', 'unknown_fields'], 'candidate');
      requireValue(['accepted', 'proposed', 'conditional', 'unknown', 'refused'].includes(raw.agreement), 'candidate.agreement is invalid');
      const proposedTerms = terms(raw.terms);
      const evidence = list(raw.evidence, 'candidate.evidence', 8).map(item =>
        citation(Object.hasOwn(state.sources, item?.source) ? state.sources[item.source] : undefined, item));
      const unknownFields = [...new Set(list(raw.unknown_fields ?? [], 'candidate.unknown_fields', MAX_UNKNOWNS).map(item =>
        text(item, 'candidate.unknown_fields item', 80)))];
      for (const key of ['owner', 'entity_id', 'amount', 'currency', 'due']) if (proposedTerms[key] === null && !unknownFields.includes(key)) unknownFields.push(key);
      list(unknownFields, 'normalized candidate.unknown_fields', MAX_UNKNOWNS);
      unknownFields.sort();
      const id = 'can_' + await sha256({ agreement: raw.agreement, terms: proposedTerms, evidence, unknown_fields: unknownFields });
      if (state.candidates[id]) return { candidate: state.candidates[id], duplicate: true };
      const supportErrors = evidence.filter(item => !item.supported).map(item => item.reason);
      if (!evidence.length) supportErrors.push('An exact source quote is required');
      const candidate = { id, state: 'proposed', agreement: raw.agreement, terms: proposedTerms, evidence,
        unknown_fields: unknownFields, supported: !supportErrors.length, support_errors: supportErrors, version_id: null };
      state.candidates[id] = candidate;
      event(state, at, 'candidate_proposed', id, { agreement: raw.agreement, supported: candidate.supported });
      return { candidate, duplicate: false };
    });
  }

  confirm(candidateId, options) {
    return this.#change(async (state, at) => {
      fields(options, ['actor', 'reason', 'replaces', 'related_to', 'target', 'resolved_unknowns'], 'confirmation');
      requireValue(!(Object.hasOwn(options, 'replaces') && Object.hasOwn(options, 'related_to')),
        'Choose either replaces or related_to, not both');
      const replaces = options.replaces ?? null;
      const related = options.related_to ?? null;
      if (replaces !== null) identifier(replaces, 'confirmation.replaces');
      if (related !== null) identifier(related, 'confirmation.related_to');
      const actor = identifier(options.actor, 'confirmation.actor');
      const reason = text(options.reason ?? '', 'confirmation.reason', 1000, { empty: true });
      identifier(candidateId, 'candidate ID');
      requireValue(Object.hasOwn(state.candidates, candidateId), 'Unknown candidate');
      const candidate = state.candidates[candidateId];
      if (candidate.version_id) return { version: state.versions[candidate.version_id], duplicate: true };
      requireValue(candidate.state === 'proposed' && candidate.supported && candidate.agreement !== 'refused', 'Unsupported, refused or rejected candidate cannot be confirmed');
      requireValue(candidate.terms.owner !== null, 'Owner requires clarification before confirmation');
      requireValue(['accepted', 'conditional'].includes(candidate.agreement) || reason.length >= 3, 'Ambiguous agreement requires an explicit manager reason');
      const target = adapterTarget(options.target);
      const resolved = [...new Set(list(options.resolved_unknowns ?? [], 'resolved_unknowns', MAX_UNKNOWNS)
        .map(item => text(item, 'resolved unknown field', 80)))];
      requireValue(resolved.every(item => candidate.unknown_fields.includes(item)), 'Only declared uncertainties can be clarified');
      requireValue(!resolved.length || reason.length >= 3, 'Clarifying uncertainty requires a manager reason');
      const linkedId = replaces ?? related;
      let linked = null;
      if (linkedId !== null) {
        linked = version(state, linkedId);
        requireValue(linked.terms.kind === candidate.terms.kind && linked.terms.entity_id === candidate.terms.entity_id
          && canonical(linked.target) === canonical(target), 'Related version must have the same kind, entity and CRM target');
        requireValue(state.commitments[linked.commitment_id]?.current === linked.id && linked.status !== 'superseded',
          'Relationship must explicitly reference the current version of this commitment');
      }
      const groupId = linked?.commitment_id ?? 'cmt_' + await sha256(candidate.terms.kind === 'crm.amount' && candidate.terms.entity_id !== null
        ? { kind: candidate.terms.kind, entity: candidate.terms.entity_id, target } : { candidate: candidate.id, target });
      let group = state.commitments[groupId];
      const previous = group ? state.versions[group.current] : null;
      if (!group) group = state.commitments[groupId] = { id: groupId, current: null, versions: [] };
      const number = group.versions.length + 1;
      const id = `${groupId}.v${number}`;
      const record = { id, commitment_id: groupId, number, candidate_id: candidate.id,
        terms: structuredClone(candidate.terms), target, terms_hash: await sha256({ terms: candidate.terms, target }),
        status: 'confirmed', dispute_kind: null, supersedes: replaces, condition_decisions: {},
        confirmation: { actor, reason, at, resolved_unknowns: resolved }, verification: null, fulfillment_receipt: null };
      if (previous && replaces === null) {
        previous.status = 'disputed'; previous.dispute_kind = 'terms_conflict';
        record.status = 'disputed'; record.dispute_kind = 'terms_conflict';
        invalidateApprovals(state, previous.id, 'Conflicting confirmed terms');
        event(state, at, 'terms_conflict', previous.id, { other_version: id, actor });
      } else if (previous) {
        if (group.versions.some(existingId => state.versions[existingId].dispute_kind === 'terms_conflict')) {
          record.status = 'disputed'; record.dispute_kind = 'terms_conflict';
        }
        previous.status = 'superseded'; previous.dispute_kind = null;
        invalidateApprovals(state, previous.id, 'Version superseded');
        event(state, at, 'superseded', previous.id, { replacement: id, actor });
      }
      state.versions[id] = record; group.versions.push(id); group.current = id;
      candidate.state = 'confirmed'; candidate.version_id = id;
      event(state, at, 'confirmed', id, { actor, reason, supersedes: replaces, ...(related !== null ? { related_to: related } : {}) });
      return { version: record, duplicate: false };
    });
  }

  decideCondition(versionId, options) {
    return this.#change((state, at) => {
      fields(options, ['actor', 'index', 'satisfied', 'reason'], 'condition decision');
      const record = version(state, versionId);
      requireValue(state.commitments[record.commitment_id].current === record.id && record.status !== 'superseded', 'Condition decision targets an obsolete version');
      const index = integer(options.index, 'condition index', 0, record.terms.conditions.length - 1);
      requireValue(typeof options.satisfied === 'boolean', 'condition.satisfied must be boolean');
      const actor = identifier(options.actor, 'condition.actor');
      const reason = text(options.reason, 'condition.reason', 1000);
      record.condition_decisions[index] = { satisfied: options.satisfied, actor, reason, at, kind: 'manager_attestation' };
      invalidateApprovals(state, record.id, 'Condition decision changed');
      if (!options.satisfied && record.status === 'fulfilled') { record.status = 'disputed'; record.dispute_kind = 'condition_changed'; }
      event(state, at, 'condition_decided', record.id, { index, ...record.condition_decisions[index] });
      return record;
    });
  }

  resolveConflict(versionId, options) {
    return this.#change((state, at) => {
      fields(options, ['actor', 'reason'], 'conflict resolution');
      const chosen = version(state, versionId);
      requireValue(chosen.dispute_kind === 'terms_conflict', 'No term conflict is awaiting resolution');
      const actor = identifier(options.actor, 'resolution.actor');
      const reason = text(options.reason, 'resolution.reason', 1000);
      const group = state.commitments[chosen.commitment_id];
      for (const id of group.versions) {
        const record = state.versions[id];
        record.status = id === chosen.id ? 'confirmed' : 'superseded'; record.dispute_kind = null;
        invalidateApprovals(state, id, 'Term conflict resolved');
      }
      group.current = chosen.id;
      event(state, at, 'conflict_resolved', chosen.id, { actor, reason });
      return chosen;
    });
  }

  approve(versionId, rawObservation, options) {
    return this.#change(async (state, at) => {
      fields(options, ['actor', 'expires_at'], 'approval');
      const record = version(state, versionId);
      requireValue(!executionReasons(state, record).length, executionReasons(state, record).join('; '));
      requireValue(!unresolvedAttempts(state, record).length, 'A prior write outcome requires fresh read reconciliation before another approval');
      const observed = observation(rawObservation);
      requireValue(canonical(targetOf(observed)) === canonical(record.target), 'Approval observation names a different CRM');
      requireFresh(observed, at);
      await acceptObservation(state, observed);
      requireValue(observed.entity_id === record.terms.entity_id, 'Approval observation names a different entity');
      requireValue(observed.amount !== record.terms.amount || observed.currency !== record.terms.currency, 'CRM already matches; verify instead of writing');
      const expires = instant(options.expires_at, 'approval.expires_at');
      requireValue(Date.parse(expires) > Date.parse(at) && Date.parse(expires) <= Date.parse(at) + 60 * 60_000, 'Approval must expire within one hour');
      const payload = { amount: record.terms.amount, currency: record.terms.currency };
      const body = { version_id: record.id, terms_hash: record.terms_hash, actor: identifier(options.actor, 'approval.actor'),
        before: beforeState(observed), before_hash: await sha256(beforeState(observed)), payload, expires_at: expires };
      const id = 'apr_' + await sha256(body);
      if (state.approvals[id]) return state.approvals[id];
      const approval = { id, ...body, state: 'approved', created_at: at };
      state.approvals[id] = approval;
      event(state, at, 'action_approved', id, { version_id: record.id, actor: body.actor, before: body.before, payload });
      return approval;
    });
  }

  beginAttempt(approvalId, rawFreshObservation) {
    return this.#change(async (state, at) => {
      const approval = state.approvals[identifier(approvalId, 'approval ID')];
      requireValue(approval, 'Unknown approval');
      const existing = Object.values(state.attempts).find(item => item.approval_id === approval.id);
      if (existing) return { attempt: existing, command: null, reconcile: true };
      const record = version(state, approval.version_id);
      requireValue(approval.state === 'approved' && Date.parse(at) < Date.parse(approval.expires_at), 'Approval is expired, invalidated or consumed');
      requireValue(approval.terms_hash === record.terms_hash && !executionReasons(state, record).length, 'Approval no longer matches an executable current version');
      requireValue(!unresolvedAttempts(state, record).length, 'A prior write outcome requires reconciliation before another command');
      const observed = observation(rawFreshObservation);
      requireFresh(observed, at);
      await acceptObservation(state, observed);
      requireValue(await sha256(beforeState(observed)) === approval.before_hash, 'Fresh CRM state differs from the approved before state');
      requireValue(canonical(approval.payload) === canonical({ amount: record.terms.amount, currency: record.terms.currency }), 'Approval payload differs from confirmed terms');
      const id = 'att_' + await sha256({ approval: approval.id });
      const attempt = { id, approval_id: approval.id, version_id: record.id, terms_hash: record.terms_hash,
        state: 'pending', created_at: at, outcome: null };
      state.attempts[id] = attempt; approval.state = 'consumed';
      event(state, at, 'write_attempt_started', id, { approval_id: approval.id, version_id: record.id });
      return { attempt, reconcile: false, command: { entityId: observed.entity_id, amount: approval.payload.amount,
        currency: approval.payload.currency, expectedRevision: observed.revision } };
    });
  }

  finishAttempt(attemptId, options) {
    return this.#change((state, at) => {
      fields(options, ['outcome', 'reason'], 'attempt result');
      requireValue(['acknowledged', 'uncertain', 'rejected'].includes(options.outcome), 'Unknown write outcome');
      const attempt = state.attempts[identifier(attemptId, 'attempt ID')];
      requireValue(attempt, 'Unknown attempt');
      requireValue(attempt.state === 'pending', 'Attempt outcome was already recorded');
      attempt.state = 'recorded'; attempt.outcome = options.outcome;
      attempt.reason = text(options.reason ?? '', 'attempt reason', 1000, { empty: true });
      event(state, at, 'write_outcome_recorded', attempt.id, { outcome: attempt.outcome, reason: attempt.reason });
      return attempt;
    });
  }

  verify(versionId, rawObservation, { attemptId = null } = {}) {
    return this.#change(async (state, at) => {
      const record = version(state, versionId);
      const observed = observation(rawObservation);
      requireFresh(observed, at);
      const reasons = executionReasons(state, record);
      const sameTarget = canonical(targetOf(observed)) === canonical(record.target);
      if (!sameTarget) reasons.push('Receipt names a different CRM');
      if (observed.entity_id !== record.terms.entity_id) reasons.push('Receipt entity differs from the confirmed entity');
      if (observed.amount !== record.terms.amount || observed.currency !== record.terms.currency) reasons.push('Observed CRM fields differ from confirmed terms');
      const sameIdentity = sameTarget && observed.entity_id === record.terms.entity_id;
      if (sameIdentity) await acceptObservation(state, observed);
      let attempt = null;
      if (attemptId !== null) {
        attempt = state.attempts[identifier(attemptId, 'attempt ID')];
        requireValue(attempt?.version_id === record.id && attempt.terms_hash === record.terms_hash, 'Attempt belongs to another term version');
        if (sameIdentity) reconcile(state, attempt, observed, at);
      } else if (sameIdentity) {
        for (const pending of unresolvedAttempts(state, record).filter(item => item.version_id === record.id)) reconcile(state, pending, observed, at);
      }
      if (sameIdentity) record.verification = { observed: structuredClone(observed), at, matched: !reasons.length, reasons };
      if (reasons.length) {
        if (record.status === 'fulfilled' && sameTarget && observed.entity_id === record.terms.entity_id) {
          record.status = 'disputed'; record.dispute_kind = 'external_mismatch';
          invalidateApprovals(state, record.id, 'External state no longer matches');
          event(state, at, 'external_state_disputed', record.id, { reasons, observation: observed });
        }
        return { matched: false, reasons, version: record };
      }
      const identity = { version_id: record.id, terms_hash: record.terms_hash, adapter: observed.adapter,
        mode: observed.mode, origin: observed.origin, entity_id: observed.entity_id, revision: observed.revision, response_sha256: observed.response_sha256 };
      const id = 'rcp_' + await sha256(identity);
      const duplicate = Boolean(state.receipts[id]);
      const receipt = state.receipts[id] ?? { id, ...identity, predicate: 'crm.amount', confirmation: structuredClone(record.confirmation),
        observation: structuredClone(observed), condition_decisions: structuredClone(record.condition_decisions),
        attempt_id: attempt?.id ?? null, recorded_at: at,
        deadline_observation: deadlineKnown(state, record)
          ? (Date.parse(observed.observed_at) <= Date.parse(record.terms.due.resolved) ? 'observed_by_deadline' : 'observed_after_deadline') : 'deadline_unresolved' };
      state.receipts[id] = receipt;
      if (record.status !== 'fulfilled') event(state, at, record.fulfillment_receipt ? 'verification_restored' : 'fulfilled', record.id, { receipt_id: id });
      record.status = 'fulfilled'; record.dispute_kind = null; record.fulfillment_receipt = id;
      invalidateApprovals(state, record.id, 'Confirmed terms are already verified');
      return { matched: true, receipt, duplicate, version: record };
    });
  }

  checkDeadlines() {
    return this.#change((state, at) => {
      const changed = [];
      for (const record of Object.values(state.versions)) {
        if (record.status === 'confirmed' && state.commitments[record.commitment_id].current === record.id
          && deadlineKnown(state, record) && Date.parse(at) > Date.parse(record.terms.due.resolved)) {
          record.status = 'overdue'; record.first_overdue_at ??= at;
          event(state, at, 'overdue_without_receipt', record.id, { deadline: record.terms.due.resolved });
          changed.push(record.id);
        }
      }
      return changed;
    });
  }

  reconcileAttempt(attemptId, rawObservation) {
    return this.#change(async (state, at) => {
      const attempt = state.attempts[identifier(attemptId, 'attempt ID')];
      requireValue(attempt, 'Unknown attempt');
      const observed = observation(rawObservation);
      requireFresh(observed, at);
      await acceptObservation(state, observed);
      return reconcile(state, attempt, observed, at);
    });
  }

  closeUncertainAttempt(attemptId, rawObservation, options) {
    return this.#change(async (state, at) => {
      fields(options, ['actor', 'reason', 'writer_quiesced'], 'Operator recovery');
      const actor = identifier(options.actor, 'Operator recovery actor');
      const reason = text(options.reason, 'Operator recovery reason', 1000);
      requireValue(options.writer_quiesced === true && reason.length >= 10,
        'Explicitly attest that the original writer request cannot apply later, and record how this was checked');
      const attempt = state.attempts[identifier(attemptId, 'Attempt ID')];
      requireValue(attempt && !attempt.reconciliation && (attempt.state === 'pending' || attempt.outcome === 'uncertain'), 'Only an unresolved pending or uncertain attempt can be closed');
      const record = version(state, attempt.version_id); const approval = state.approvals[attempt.approval_id];
      const observed = observation(rawObservation); requireFresh(observed, at);
      requireValue(canonical(targetOf(observed)) === canonical(record.target) && observed.entity_id === record.terms.entity_id,
        'Operator recovery read names another CRM or entity');
      requireValue(Date.parse(observed.observed_at) >= Date.parse(attempt.created_at)
        && Number(observed.revision) >= Number(approval.before.revision), 'Operator recovery requires a new reader observation at or beyond the approved revision');
      requireValue(observed.amount !== record.terms.amount || observed.currency !== record.terms.currency,
        'A matching effect can be reconciled through ordinary independent verification');
      await acceptObservation(state, observed);
      const previousOutcome = attempt.outcome;
      attempt.state = 'recorded'; attempt.outcome ??= 'uncertain';
      attempt.reconciliation = { kind: 'operator_attestation', matched: false, at, actor, reason,
        writer_quiesced: true, observation: structuredClone(observed), external_nonexecution_proven: false };
      attempt.capacity_settled = true;
      event(state, at, 'uncertain_attempt_closed_by_operator', attempt.id, { actor, reason, writer_quiesced: true,
        previous_outcome: previousOutcome, observation: observed, external_nonexecution_proven: false });
      return { resolved: true, attempt, fulfillment_proven: false, automatic_retry: false };
    }, { settleAttempt: attemptId });
  }
}

async function validateIntegrity(state) {
  for (const [id, source] of Object.entries(state.sources)) requireValue((await makeSource(source)).id === id && source.id === id, 'Saved source hash does not match its content');
  for (const [id, candidate] of Object.entries(state.candidates)) {
    requireValue(canonical(terms(candidate.terms)) === canonical(candidate.terms), 'Saved candidate terms are not canonical');
    const checked = candidate.evidence.map(item => citation(state.sources[item.source], Object.fromEntries(
      ['source', 'segment', 'quote', 'start', 'end'].filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]))));
    requireValue(canonical(checked) === canonical(candidate.evidence), 'Saved source citations changed');
    requireValue(candidate.supported === (checked.length > 0 && checked.every(item => item.supported)), 'Saved candidate support flag disagrees with its source evidence');
    requireValue(['proposed', 'confirmed', 'rejected'].includes(candidate.state)
      && (candidate.state === 'confirmed' ? Object.hasOwn(state.versions, candidate.version_id) : candidate.version_id === null), 'Saved candidate lifecycle changed');
    const expected = 'can_' + await sha256({ agreement: candidate.agreement, terms: candidate.terms, evidence: checked, unknown_fields: candidate.unknown_fields });
    requireValue(id === expected && candidate.id === id, 'Saved candidate hash does not match its content');
  }
  for (const record of Object.values(state.versions)) {
    requireValue(await sha256({ terms: record.terms, target: adapterTarget(record.target) }) === record.terms_hash, 'Saved version terms hash does not match');
    requireValue(state.candidates[record.candidate_id].version_id === record.id, 'Saved candidate/version link changed');
    if (record.verification) {
      const checked = observation(record.verification.observed);
      const key = 'obs_' + await sha256({ target: targetOf(checked), entity_id: checked.entity_id });
      const high = state.observations[key];
      requireValue(high && Number(high.revision) >= Number(checked.revision)
        && Date.parse(high.observed_at) >= Date.parse(checked.observed_at), 'Saved observation ordering was downgraded');
    }
  }
  for (const [id, approval] of Object.entries(state.approvals)) {
    const body = Object.fromEntries(['version_id', 'terms_hash', 'actor', 'before', 'before_hash', 'payload', 'expires_at'].map(key => [key, approval[key]]));
    requireValue(await sha256(approval.before) === approval.before_hash && id === 'apr_' + await sha256(body) && approval.id === id, 'Saved approval binding changed');
    requireValue(state.versions[approval.version_id]?.terms_hash === approval.terms_hash, 'Saved approval names different terms');
  }
  for (const [id, attempt] of Object.entries(state.attempts)) requireValue(id === 'att_' + await sha256({ approval: attempt.approval_id })
    && attempt.id === id && state.approvals[attempt.approval_id]?.version_id === attempt.version_id
    && state.versions[attempt.version_id]?.terms_hash === attempt.terms_hash, 'Saved attempt binding changed');
  for (const [id, receipt] of Object.entries(state.receipts)) {
    const body = Object.fromEntries(['version_id', 'terms_hash', 'adapter', 'mode', 'origin', 'entity_id', 'revision', 'response_sha256'].map(key => [key, receipt[key]]));
    const record = state.versions[receipt.version_id]; const observed = observation(receipt.observation);
    requireValue(id === 'rcp_' + await sha256(body) && receipt.id === id && record?.terms_hash === receipt.terms_hash
      && canonical(targetOf(observed)) === canonical(record.target) && observed.entity_id === record.terms.entity_id
      && observed.amount === record.terms.amount && observed.currency === record.terms.currency, 'Saved fulfillment receipt binding changed');
    requireValue(['adapter', 'mode', 'origin', 'entity_id', 'revision', 'response_sha256'].every(key => body[key] === observed[key]),
      'Saved receipt identity differs from its observation');
  }
  for (const [id, raw] of Object.entries(state.observations)) {
    const observed = observation(raw);
    requireValue(id === 'obs_' + await sha256({ target: targetOf(observed), entity_id: observed.entity_id }), 'Saved observation identity changed');
  }
}

function requireFresh(record, at) {
  const age = Date.parse(at) - Date.parse(record.observed_at);
  requireValue(age >= -5000 && age <= 60_000, 'A fresh reader observation within sixty seconds is required');
}
