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
  const restored = new Pactspan(app.snapshot(), { clock: () => AT });
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
  assert.equal((await app.verify(proposal.id, await observed('8000'))).matched, false);
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
  assert.equal((await app.verify(conflicting.id, await observed('10800'))).matched, false);
  await assert.rejects(app.beginAttempt(approval.id, before), /invalidated/);
  await app.resolveConflict(conflicting.id, { actor: 'manager', reason: 'Reviewed both exact sources and selected the accepted amendment' });
  const newApproval = await app.approve(conflicting.id, before, { actor: 'manager', expires_at: LATER });
  now = '2030-01-08T09:11:00.000Z';
  await assert.rejects(app.beginAttempt(newApproval.id, await observed('15000', '1', { observed_at: now })), /expired/);
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
  assert.throws(() => new Pactspan(forged), /receipt/);
});
