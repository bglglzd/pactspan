import test from 'node:test';
import assert from 'node:assert/strict';
import { Pactspan, invariantErrors } from '../src/core/engine.mjs';
import { sha256 } from '../src/core/data.mjs';

const TARGET = { adapter: 'demo', mode: 'synthetic', origin: 'demo://crm' };
const AT = '2030-01-08T09:00:00.000Z';
const LATER = '2030-01-08T09:10:00.000Z';
function engine(clock = () => AT) { return new Pactspan(undefined, { clock }); }
async function candidate(app, value = '12000', changes = {}) {
  const quote = `Alex agrees to record USD ${value} on O1. No proposal has been sent.`;
  const imported = await app.importSource({ title: `Terms ${value}`, participants: [{ speaker: 'Alex', person_id: 'alex' }],
    segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 5, text: quote }] });
  return (await app.propose({ agreement: 'accepted', evidence: [{ source: imported.source.id, segment: 0, quote }],
    terms: { kind: 'crm.amount', entity_id: 'O1', amount: value, currency: 'USD', owner: 'alex', ...changes }, unknown_fields: [] })).candidate;
}
async function confirm(app, proposed, changes = {}) {
  return (await app.confirm(proposed.id, { actor: 'manager', target: TARGET, ...changes })).version;
}
async function observed(value, revision = '1', changes = {}) {
  const record = { schema_version: 1, ...TARGET, entity_id: 'O1', amount: value, currency: 'USD', revision,
    observed_at: AT, ...changes };
  return { ...record, response_sha256: await sha256(record) };
}

test('approved write ACK is not fulfillment; fresh receipt, replay and restart preserve one completion', async () => {
  const app = engine(); const proposed = await candidate(app); const current = await confirm(app, proposed);
  const before = await observed('15000');
  const approval = await app.approve(current.id, before, { actor: 'manager', expires_at: LATER });
  const started = await app.beginAttempt(approval.id, before);
  assert.deepEqual(started.command, { entityId: 'O1', amount: '12000', currency: 'USD', expectedRevision: '1' });
  await app.finishAttempt(started.attempt.id, { outcome: 'acknowledged' });
  assert.equal(app.view(current.id).status, 'confirmed');
  const after = await observed('12000', '2');
  const first = await app.verify(current.id, after, { attemptId: started.attempt.id });
  assert.equal(first.matched, true);
  assert.equal(first.receipt.version_id, current.id);
  const restored = await Pactspan.restore(app.snapshot(), { clock: () => AT });
  const repeat = await restored.verify(current.id, after);
  assert.equal(repeat.duplicate, true);
  assert.equal(restored.snapshot().events.filter(row => row.action === 'fulfilled').length, 1);
  assert.equal((await restored.beginAttempt(approval.id, after)).command, null);
  assert.deepEqual(invariantErrors(restored.snapshot()), []);
});

test('explicit accepted amendment supersedes only its own version and rejects old/wrong-entity/other-CRM evidence', async () => {
  const app = engine(); const first = await confirm(app, await candidate(app));
  const oldReceipt = await app.verify(first.id, await observed('12000'));
  assert.equal(oldReceipt.matched, true);
  const second = await confirm(app, await candidate(app, '10800'), { replaces: first.id });
  assert.equal(app.view(first.id).status, 'superseded');
  assert.equal((await app.verify(first.id, await observed('12000'))).matched, false);
  assert.equal((await app.verify(second.id, await observed('10800', '2', { entity_id: 'O2' }))).matched, false);
  const differentCRM = await observed('10800', '2', { adapter: 'espocrm', mode: 'single-writer-sandbox', origin: 'http://127.0.0.1:1234' });
  assert.equal((await app.verify(second.id, differentCRM)).matched, false);
  assert.equal(app.view(second.id).status, 'confirmed');
  assert.equal((await app.verify(second.id, await observed('10800', '2'))).matched, true);
  assert.ok(app.snapshot().receipts[oldReceipt.receipt.id]);
});

test('unknown prerequisites, missing owner, draft-only proposal and unsupported quotes cannot fulfill', async () => {
  const app = engine();
  const conditional = await confirm(app, await candidate(app, '10800', { conditions: [{ literal: 'Finance approves', status: 'satisfied' }] }));
  assert.equal((await app.verify(conditional.id, await observed('10800'))).matched, false);
  await app.decideCondition(conditional.id, { index: 0, actor: 'manager', satisfied: true, reason: 'Explicit manager attestation of finance approval' });
  assert.equal((await app.verify(conditional.id, await observed('10800'))).matched, true);
  const missing = await candidate(app, '9000', { owner: null });
  await assert.rejects(confirm(app, missing, { replaces: conditional.id }), /Owner requires clarification/);
  assert.equal(app.snapshot().candidates[missing.id].state, 'proposed');
  const proposal = await confirm(app, await candidate(app, '8000', { kind: 'proposal.sent' }));
  assert.equal((await app.verify(proposal.id, await observed('8000', '2'))).matched, false);
  const source = Object.values(app.snapshot().sources)[0];
  const unsupported = (await app.propose({ agreement: 'accepted', evidence: [{ source: source.id, segment: 0, quote: 'Invented agreement' }],
    terms: { kind: 'crm.amount', entity_id: 'O2', amount: '10800', currency: 'USD', owner: 'alex' } })).candidate;
  await assert.rejects(confirm(app, unsupported), /Unsupported/);
  const refused = (await app.propose({ agreement: 'refused', evidence: [{ source: source.id, segment: 0, quote: source.segments[0].text }],
    terms: { kind: 'crm.amount', entity_id: 'O2', amount: '10800', currency: 'USD', owner: 'alex' } })).candidate;
  await assert.rejects(confirm(app, refused), /refused/);
});

test('conflicts and changed/expired approvals are refused before any write command', async () => {
  let now = AT;
  const app = engine(() => now); const first = await confirm(app, await candidate(app));
  const before = await observed('15000');
  const approval = await app.approve(first.id, before, { actor: 'manager', expires_at: LATER });
  await assert.rejects(app.beginAttempt(approval.id, await observed('15000', '2')), /differs/);
  assert.equal(Object.keys(app.snapshot().attempts).length, 0);
  const conflicting = await confirm(app, await candidate(app, '10800'));
  assert.equal(app.view(first.id).status, 'disputed'); assert.equal(app.view(conflicting.id).status, 'disputed');
  assert.equal((await app.verify(conflicting.id, await observed('10800', '2'))).matched, false);
  await assert.rejects(app.beginAttempt(approval.id, before), /invalidated/);
  await app.resolveConflict(conflicting.id, { actor: 'manager', reason: 'Reviewed both exact sources and selected the accepted amendment' });
  const currentBefore = await observed('15000', '3');
  const newApproval = await app.approve(conflicting.id, currentBefore, { actor: 'manager', expires_at: LATER });
  now = '2030-01-08T09:11:00.000Z';
  await assert.rejects(app.beginAttempt(newApproval.id, await observed('15000', '3', { observed_at: now })), /expired/);
  assert.equal(Object.keys(app.snapshot().attempts).length, 0);
});

test('late verification retains overdue history, then rollback disputes without erasing prior evidence', async () => {
  let now = AT;
  const app = engine(() => now);
  const current = await confirm(app, await candidate(app, '12000', {
    due: { literal: 'by 09:05 UTC', resolved: '2030-01-08T09:05:00Z', precision: 'instant', zone: 'UTC' } }));
  now = LATER;
  await app.checkDeadlines(); assert.equal(app.view(current.id).status, 'overdue');
  const receipt = await app.verify(current.id, await observed('12000', '1', { observed_at: now }));
  assert.equal(receipt.receipt.deadline_observation, 'observed_after_deadline');
  assert.ok(app.view(current.id).first_overdue_at);
  await app.verify(current.id, await observed('15000', '2', { observed_at: now }));
  assert.equal(app.view(current.id).status, 'disputed');
  assert.ok(app.snapshot().receipts[receipt.receipt.id]);
  assert.equal(app.snapshot().events.filter(row => row.action === 'overdue_without_receipt').length, 1);
});

test('failed malformed changes preserve the prior workspace and cannot poison the action queue', async () => {
  const app = engine(); const current = await confirm(app, await candidate(app)); const before = app.snapshot();
  await assert.rejects(app.propose({ agreement: 'accepted', terms: { kind: 'other' }, evidence: [null] }), /citation must be an object/);
  assert.deepEqual(app.snapshot(), before);
  assert.throws(() => app.view('constructor'), /Unknown commitment version/);
  assert.equal((await app.verify(current.id, await observed('12000'))).matched, true);
  const forged = app.snapshot(); forged.versions[current.id].fulfillment_receipt = 'missing';
  await assert.rejects(Pactspan.restore(forged), /receipt/);
});

test('an older matching observation cannot erase newer rollback evidence, including after restart', async () => {
  let now = AT;
  const app = engine(() => now); const current = await confirm(app, await candidate(app));
  const earlier = await observed('12000', '2');
  await app.verify(current.id, earlier);
  now = '2030-01-08T09:00:10.000Z';
  await app.verify(current.id, await observed('15000', '3', { observed_at: now }));
  now = '2030-01-08T09:00:20.000Z';
  const restored = await Pactspan.restore(app.snapshot(), { clock: () => now });
  await assert.rejects(restored.verify(current.id, earlier), /Stale observation/);
  assert.equal(restored.view(current.id).status, 'disputed');
  assert.equal(restored.view(current.id).verification.observed.amount, '15000');
  assert.equal(restored.snapshot().events.filter(row => row.action === 'verification_restored').length, 0);
});

test('a fresh counter-observation on an already reconciled attempt cannot be discarded or overwritten by its older receipt', async () => {
  const app = engine(); const proposed = await candidate(app); const current = await confirm(app, proposed);
  const before = await observed('15000'); const approval = await app.approve(current.id, before, { actor: 'manager', expires_at: LATER });
  const started = await app.beginAttempt(approval.id, before); await app.finishAttempt(started.attempt.id, { outcome: 'acknowledged' });
  const matched = await observed('12000', '2'); await app.verify(current.id, matched);
  await app.reconcileAttempt(started.attempt.id, await observed('13000', '3'));
  assert.equal(app.view(current.id).status, 'disputed');
  await assert.rejects(app.verify(current.id, matched), /Stale observation/);
  assert.equal(Object.keys(app.snapshot().receipts).length, 1);
});

test('uncertain attempt blocks a new approval across versions until a matching fresh read reconciles it', async () => {
  let now = AT;
  const app = engine(() => now); const first = await confirm(app, await candidate(app));
  const before = await observed('15000');
  const approved = await app.approve(first.id, before, { actor: 'manager', expires_at: LATER });
  const started = await app.beginAttempt(approved.id, before);
  await app.finishAttempt(started.attempt.id, { outcome: 'uncertain' });
  const restored = await Pactspan.restore(app.snapshot(), { clock: () => now });
  await assert.rejects(restored.approve(first.id, before, { actor: 'manager', expires_at: '2030-01-08T09:11:00Z' }), /reconciliation/);
  const second = await confirm(restored, await candidate(restored, '10800'), { replaces: first.id });
  await assert.rejects(restored.approve(second.id, before, { actor: 'manager', expires_at: LATER }), /reconciliation/);
  now = '2030-01-08T09:00:10.000Z';
  const stillOld = await observed('15000', '1', { observed_at: now });
  assert.equal((await restored.reconcileAttempt(started.attempt.id, stillOld)).resolved, false);
  await assert.rejects(restored.approve(second.id, stillOld, { actor: 'manager', expires_at: LATER }), /reconciliation/);
  const committed = await observed('12000', '2', { observed_at: now });
  assert.equal((await restored.reconcileAttempt(started.attempt.id, committed)).resolved, true);
  assert.equal(restored.view(first.id).status, 'superseded');
  assert.equal(Object.keys(restored.snapshot().receipts).length, 0);
  const newApproval = await restored.approve(second.id, committed, { actor: 'manager', expires_at: LATER });
  assert.equal((await restored.beginAttempt(newApproval.id, committed)).command.amount, '10800');
});

test('restored terms, candidates and hashes must agree before another approval is possible', async () => {
  const app = engine(); const current = await confirm(app, await candidate(app));
  const changed = app.snapshot(); changed.versions[current.id].terms.amount = '99999';
  await assert.rejects(Pactspan.restore(changed), /candidate/);
  const changedTogether = app.snapshot();
  changedTogether.versions[current.id].terms.amount = '99999';
  changedTogether.candidates[current.candidate_id].terms.amount = '99999';
  await assert.rejects(Pactspan.restore(changedTogether), /hash/);
  assert.throws(() => new Pactspan(app.snapshot()), /Pactspan.restore/);
});

test('a later replacement cannot erase an unresolved conflict or survive selection of another version', async () => {
  const app = engine(); const a = await confirm(app, await candidate(app, '12000'));
  const b = await confirm(app, await candidate(app, '11000'));
  const c = await confirm(app, await candidate(app, '10800'), { replaces: b.id });
  assert.equal(app.view(c.id).status, 'disputed');
  await assert.rejects(app.approve(c.id, await observed('15000'), { actor: 'manager', expires_at: LATER }), /Conflicting/);
  await app.resolveConflict(a.id, { actor: 'manager', reason: 'Explicitly selected original source after reviewing all three' });
  assert.equal(app.view(a.id).status, 'confirmed');
  assert.equal(app.view(b.id).status, 'superseded'); assert.equal(app.view(c.id).status, 'superseded');
  await assert.rejects(app.approve(c.id, await observed('15000'), { actor: 'manager', expires_at: LATER }), /not current/);
});

test('uncertain deadline fields cannot create an overdue or on-time claim', async () => {
  let now = AT;
  const app = engine(() => now);
  const original = await candidate(app, '12000', { due: { literal: 'Unclarified time', precision: 'instant', resolved: '2030-01-08T09:05:00Z', zone: 'UTC' } });
  const raw = { agreement: 'accepted', terms: original.terms, evidence: original.evidence.map(({ source, segment, quote, start, end }) => ({ source, segment, quote, start, end })), unknown_fields: ['due.resolved'] };
  const uncertain = (await app.propose(raw)).candidate;
  const current = await confirm(app, uncertain);
  now = LATER;
  assert.deepEqual(await app.checkDeadlines(), []);
  const result = await app.verify(current.id, await observed('12000', '1', { observed_at: now }));
  assert.equal(result.receipt.deadline_observation, 'deadline_unresolved');
  assert.equal(app.snapshot().events.filter(row => row.action === 'overdue_without_receipt').length, 0);
});
