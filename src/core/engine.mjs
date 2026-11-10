import { canonical, fields, identifier, instant, integer, jsonData, list, requireValue, sha256, text } from './data.mjs';
import { makeSource, citation } from './source.mjs';
import { adapterTarget, beforeState, observation, targetOf, terms } from './terms.mjs';

export function emptyState() {
  return { schema_version: 1, sources: {}, candidates: {}, commitments: {}, versions: {}, approvals: {}, attempts: {}, receipts: {}, events: [] };
}

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

export function invariantErrors(state) {
  const errors = [];
  for (const group of Object.values(state.commitments)) {
    if (!group.versions.every(id => state.versions[id]?.commitment_id === group.id)) errors.push('Commitment version references are invalid');
    if (!group.versions.includes(group.current)) errors.push('Current commitment version is absent');
  }
  for (const record of Object.values(state.versions)) {
    if (!state.candidates[record.candidate_id] || !record.confirmation) errors.push('Version has no candidate or manager confirmation');
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

  constructor(snapshot = emptyState(), { clock = () => new Date().toISOString() } = {}) {
    jsonData(snapshot);
    fields(snapshot, Object.keys(emptyState()), 'workspace');
    requireValue(snapshot.schema_version === 1, 'workspace.schema_version must be 1');
    for (const key of Object.keys(emptyState()).filter(key => !['schema_version', 'events'].includes(key))) {
      requireValue(snapshot[key] !== null && typeof snapshot[key] === 'object' && !Array.isArray(snapshot[key]), `workspace.${key} must be an object`);
    }
    list(snapshot.events, 'workspace.events', 5000);
    const errors = invariantErrors(snapshot);
    requireValue(!errors.length, errors.join('; '));
    this.#state = structuredClone(snapshot); this.#clock = clock;
  }

  snapshot() { return structuredClone(this.#state); }
  now() { return instant(this.#clock(), 'clock'); }
  view(id) {
    const record = version(this.#state, id);
    return { ...structuredClone(record), execution_reasons: executionReasons(this.#state, record) };
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
      const unknownFields = [...new Set(list(raw.unknown_fields ?? [], 'candidate.unknown_fields', 16).map(item =>
        text(item, 'candidate.unknown_fields item', 80)))];
      for (const key of ['owner', 'entity_id', 'amount', 'currency', 'due']) if (proposedTerms[key] === null && !unknownFields.includes(key)) unknownFields.push(key);
      const id = 'can_' + await sha256({ agreement: raw.agreement, terms: proposedTerms, evidence });
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
      fields(options, ['actor', 'reason', 'replaces', 'target', 'resolved_unknowns'], 'confirmation');
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
      const resolved = [...new Set(list(options.resolved_unknowns ?? [], 'resolved_unknowns', 16)
        .map(item => text(item, 'resolved unknown field', 80)))];
      requireValue(resolved.every(item => candidate.unknown_fields.includes(item)), 'Only declared uncertainties can be clarified');
      requireValue(!resolved.length || reason.length >= 3, 'Clarifying uncertainty requires a manager reason');
      const groupId = 'cmt_' + await sha256(candidate.terms.entity_id === null
        ? { candidate: candidate.id, target } : { kind: candidate.terms.kind, entity: candidate.terms.entity_id, target });
      let group = state.commitments[groupId];
      const previous = group ? state.versions[group.current] : null;
      const replaces = options.replaces ?? null;
      if (replaces !== null) requireValue(previous && replaces === previous.id, 'Replacement must explicitly reference the current version of this commitment');
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
        previous.status = 'superseded'; previous.dispute_kind = null;
        invalidateApprovals(state, previous.id, 'Version superseded');
        event(state, at, 'superseded', previous.id, { replacement: id, actor });
      }
      state.versions[id] = record; group.versions.push(id); group.current = id;
      candidate.state = 'confirmed'; candidate.version_id = id;
      event(state, at, 'confirmed', id, { actor, reason, supersedes: replaces });
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
        if (record.dispute_kind === 'terms_conflict') {
          record.status = id === chosen.id ? 'confirmed' : 'superseded'; record.dispute_kind = null;
          invalidateApprovals(state, id, 'Term conflict resolved');
        }
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
      const observed = observation(rawObservation);
      requireValue(canonical(targetOf(observed)) === canonical(record.target), 'Approval observation names a different CRM');
      requireFresh(observed, at);
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
      const observed = observation(rawFreshObservation);
      requireFresh(observed, at);
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
      let attempt = null;
      if (attemptId !== null) {
        attempt = state.attempts[identifier(attemptId, 'attempt ID')];
        requireValue(attempt?.version_id === record.id && attempt.terms_hash === record.terms_hash, 'Attempt belongs to another term version');
      }
      record.verification = { observed, at, matched: !reasons.length, reasons };
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
        observation: observed, attempt_id: attempt?.id ?? null, recorded_at: at,
        deadline_observation: record.terms.due?.precision === 'instant' && record.terms.due.resolved !== null
          && state.candidates[record.candidate_id].unknown_fields.filter(field => field === 'due' || field.startsWith('due.'))
            .every(field => record.confirmation.resolved_unknowns.includes(field))
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
          && record.terms.due?.precision === 'instant' && Date.parse(at) > Date.parse(record.terms.due.resolved)) {
          record.status = 'overdue'; record.first_overdue_at ??= at;
          event(state, at, 'overdue_without_receipt', record.id, { deadline: record.terms.due.resolved });
          changed.push(record.id);
        }
      }
      return changed;
    });
  }
}

function requireFresh(record, at) {
  const age = Date.parse(at) - Date.parse(record.observed_at);
  requireValue(age >= -5000 && age <= 60_000, 'A fresh reader observation within sixty seconds is required');
}
