import test from 'node:test';
import assert from 'node:assert/strict';
import { Pactspan } from '../src/core/engine.mjs';
import { DemoCRM, DEMO_TARGET } from '../src/adapters/demo.mjs';

test('an operator can close a drained uncertain request with a fresh nonmatching read, without claiming proof or replaying its approval', async () => {
  const clock = () => '2030-01-08T10:00:00.000Z'; const app = new Pactspan(undefined, { clock });
  const quote = 'Alex agrees to record USD 10800 on O1.';
  const { source } = await app.importSource({ participants: [{ speaker: 'Alex', person_id: 'alex' }], segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 2, text: quote }] });
  const { candidate } = await app.propose({ agreement: 'accepted', terms: { kind: 'crm.amount', entity_id: 'O1', amount: '10800', currency: 'USD', owner: 'alex' }, evidence: [{ source: source.id, segment: 0, quote }] });
  const { version } = await app.confirm(candidate.id, { actor: 'manager', target: DEMO_TARGET });
  const crm = new DemoCRM({ records: [{ entity_id: 'O1', amount: '12000', currency: 'USD', revision: 1 }, { entity_id: 'O2', amount: '12000', currency: 'USD', revision: 1 }], clock });
  const before = await crm.readOpportunity('O1');
  const approval = await app.approve(version.id, before, { actor: 'manager', expires_at: '2030-01-08T10:15:00Z' });
  const started = await app.beginAttempt(approval.id, before); await app.finishAttempt(started.attempt.id, { outcome: 'uncertain' });
  assert.equal((await app.reconcileAttempt(started.attempt.id, await crm.readOpportunity('O1'))).resolved, false);
  const options = { actor: 'operator', reason: 'Synthetic operator confirms the original request was stopped and drained', writer_quiesced: true };
  await assert.rejects(app.closeUncertainAttempt(started.attempt.id, before, { ...options, writer_quiesced: false }), /attest/);
  await assert.rejects(app.closeUncertainAttempt(started.attempt.id, await crm.readOpportunity('O2'), options), /another CRM or entity/);
  const result = await app.closeUncertainAttempt(started.attempt.id, await crm.readOpportunity('O1'), options);
  assert.equal(result.fulfillment_proven, false); assert.equal(result.automatic_retry, false);
  assert.equal(result.attempt.outcome, 'uncertain'); assert.equal(result.attempt.reconciliation.external_nonexecution_proven, false);
  assert.equal(Object.keys(app.snapshot().receipts).length, 0); assert.equal(app.view(version.id).status, 'confirmed');
  const restored = await Pactspan.restore(app.snapshot(), { clock });
  assert.equal(restored.snapshot().events.at(-1).action, 'uncertain_attempt_closed_by_operator');
  const repeat = await restored.beginAttempt(approval.id, await crm.readOpportunity('O1')); assert.equal(repeat.command, null);
  const next = await restored.approve(version.id, await crm.readOpportunity('O1'), { actor: 'manager', expires_at: '2030-01-08T10:20:00Z' });
  assert.notEqual(next.id, approval.id); assert.ok((await restored.beginAttempt(next.id, await crm.readOpportunity('O1'))).command);
  assert.equal(crm.snapshot().ledger.length, 0); // Operator closure itself never writes to the external store.
});
