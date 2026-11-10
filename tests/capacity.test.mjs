import test from 'node:test';
import assert from 'node:assert/strict';
import { Pactspan, WORKSPACE_LIMITS, workspaceUsage, workspaceSettlementEligible } from '../src/core/engine.mjs';
import { sha256 } from '../src/core/data.mjs';

const AT = '2030-01-08T09:00:00.000Z';
const TARGET = { adapter: 'demo', mode: 'synthetic', origin: 'demo://crm' };
const clock = () => AT;

async function observed(entity = 'O1', amount = '15000', revision = '1') {
  const raw = { schema_version: 1, ...TARGET, entity_id: entity, amount, currency: 'USD', revision, observed_at: AT };
  return { ...raw, response_sha256: await sha256(raw) };
}

async function setup(entities = ['O1']) {
  const app = new Pactspan(undefined, { clock });
  const rows = [];
  for (const entity of entities) {
    const quote = `Alex agrees to record USD 12000 on ${entity}.`;
    const { source } = await app.importSource({ title: entity, participants: [{ speaker: 'Alex', person_id: 'alex' }],
      segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 5, text: quote }] });
    const { candidate } = await app.propose({ agreement: 'accepted', evidence: [{ source: source.id, segment: 0, quote }],
      terms: { kind: 'crm.amount', entity_id: entity, amount: '12000', currency: 'USD', owner: 'alex' } });
    const { version } = await app.confirm(candidate.id, { actor: 'manager', target: TARGET });
    const before = await observed(entity);
    const approval = await app.approve(version.id, before, { actor: 'manager', expires_at: '2030-01-08T09:10:00Z' });
    rows.push({ version, before, approval });
  }
  return { app, rows };
}

// Restored historical records isolate the capacity boundary without thousands of unrelated actions.
function historical(state) {
  return { sequence: state.events.length + 1, at: AT, action: 'capacity_fixture_history', target: 'fixture', detail: null };
}

function nearNodes(state, target) {
  let nodes = workspaceUsage(state).nodes;
  while (nodes + 6 <= target) { state.events.push(historical(state)); nodes += 6; }
  return state;
}

function nearBytes(state, target) {
  while (workspaceUsage(state).bytes < target) {
    const row = { ...historical(state), detail: '' };
    state.events.push(row);
    const remaining = target - workspaceUsage(state).bytes;
    if (remaining < 0) { state.events.pop(); break; }
    row.detail = 'x'.repeat(Math.min(200_000, remaining));
  }
  return state;
}

async function refusesGrowth(app) {
  const saved = app.snapshot();
  await assert.rejects(app.importSource({ title: 'New source', segments: [{ speaker: 'Other', start_secs: 0, end_secs: 1, text: 'New evidence.' }] }),
    /Workspace growth capacity reached.*export.*fresh workspace/);
  assert.deepEqual(app.snapshot(), saved);
}

test('near-node capacity refuses growth but retains finish, separate reconcile and verification across restore', async () => {
  const { app: initial, rows: [row, unrelated] } = await setup(['O1', 'O2']);
  const app = await Pactspan.restore(nearNodes(initial.snapshot(), WORKSPACE_LIMITS.soft.nodes - 20), { clock });
  const started = await app.beginAttempt(row.approval.id, row.before);
  assert.ok(started.command);
  assert.equal(workspaceSettlementEligible(app.snapshot(), { settleAttempt: started.attempt.id }), true);
  assert.equal(workspaceSettlementEligible(app.snapshot(), { verifyVersion: row.version.id }), true);
  assert.equal(workspaceSettlementEligible(app.snapshot(), { verifyVersion: unrelated.version.id }), false);
  assert.equal(workspaceSettlementEligible(app.snapshot(), {}), false);
  assert.equal(workspaceUsage(app.snapshot()).within_soft, true);
  await app.finishAttempt(started.attempt.id, { outcome: 'acknowledged' });
  assert.equal(workspaceUsage(app.snapshot()).within_soft, false);
  assert.equal(Object.keys(app.snapshot().receipts).length, 0);
  await refusesGrowth(app);
  const unchanged = app.snapshot();
  await assert.rejects(app.verify(unrelated.version.id, await observed('O2', '12000', '2')), /growth capacity/);
  assert.deepEqual(app.snapshot(), unchanged);
  const restored = await Pactspan.restore(app.snapshot(), { clock });
  const after = await observed('O1', '12000', '2');
  assert.equal((await restored.reconcileAttempt(started.attempt.id, after)).resolved, true);
  assert.equal(Object.keys(restored.snapshot().receipts).length, 0);
  assert.equal((await restored.verify(row.version.id, after)).matched, true);
  assert.equal(restored.view(row.version.id).status, 'fulfilled');
  assert.equal(restored.snapshot().attempts[started.attempt.id].capacity_settled, true);
  assert.equal(workspaceSettlementEligible(restored.snapshot(), { verifyVersion: row.version.id }), false);
  assert.equal(Object.keys(restored.snapshot().receipts).length, 1);
  assert.equal(workspaceUsage(restored.snapshot()).within_hard, true);
  const saved = restored.snapshot();
  assert.equal((await restored.reconcileAttempt(started.attempt.id, after)).duplicate, true);
  assert.deepEqual(restored.snapshot(), saved);
  await assert.rejects(restored.reconcileAttempt(started.attempt.id, await observed('O1', '12000', '3')), /growth capacity/);
  assert.deepEqual(restored.snapshot(), saved);
  await refusesGrowth(restored);
});

test('near-byte capacity reserves ACK and fresh independent verification without raising the hard limit', async () => {
  const { app: initial, rows: [row] } = await setup();
  const app = await Pactspan.restore(nearBytes(initial.snapshot(), WORKSPACE_LIMITS.soft.bytes - 1500), { clock });
  const started = await app.beginAttempt(row.approval.id, row.before);
  assert.equal(workspaceUsage(app.snapshot()).within_soft, true);
  await app.finishAttempt(started.attempt.id, { outcome: 'acknowledged', reason: 'a'.repeat(1000) });
  const usage = workspaceUsage(app.snapshot());
  assert.ok(usage.bytes > WORKSPACE_LIMITS.soft.bytes);
  assert.equal(usage.within_hard, true);
  await refusesGrowth(app);
  assert.equal(Object.keys(app.snapshot().receipts).length, 0);
  const verified = await app.verify(row.version.id, await observed('O1', '12000', '2'));
  assert.equal(verified.matched, true);
  assert.equal(Object.keys(app.snapshot().receipts).length, 1);
  await Pactspan.restore(app.snapshot(), { clock });
});

test('the former near-hard fixture now refuses begin before returning any command and leaves approval reusable', async () => {
  const { app: initial, rows: [row] } = await setup();
  const app = await Pactspan.restore(nearNodes(initial.snapshot(), WORKSPACE_LIMITS.hard.nodes - 36), { clock });
  const saved = app.snapshot();
  await assert.rejects(app.beginAttempt(row.approval.id, row.before), /growth capacity/);
  assert.deepEqual(app.snapshot(), saved);
  assert.equal(app.snapshot().approvals[row.approval.id].state, 'approved');
  assert.equal(Object.keys(app.snapshot().attempts).length, 0);
});

test('one unsettled workspace write blocks a command and approval for another entity until fresh reconciliation', async () => {
  const { app, rows: [one, two] } = await setup(['O1', 'O2']);
  const started = await app.beginAttempt(one.approval.id, one.before);
  const saved = app.snapshot();
  await assert.rejects(app.beginAttempt(two.approval.id, two.before), /workspace write outcome.*reconciliation/);
  assert.deepEqual(app.snapshot(), saved);
  await assert.rejects(app.approve(two.version.id, two.before, { actor: 'manager', expires_at: '2030-01-08T09:11:00Z' }), /workspace write outcome.*reconciliation/);
  await app.finishAttempt(started.attempt.id, { outcome: 'acknowledged' });
  await assert.rejects(app.beginAttempt(two.approval.id, two.before), /reconciliation/);
  const mismatch = await observed('O1', '15000', '2');
  assert.equal((await app.reconcileAttempt(started.attempt.id, mismatch)).resolved, true);
  assert.ok((await app.beginAttempt(two.approval.id, two.before)).command);
  assert.equal(app.snapshot().attempts[started.attempt.id].capacity_settled, true);
});

test('repeated uncertain nonmatches retain bounded first/latest evidence and one event until actual resolution', async () => {
  const { app: initial, rows: [row] } = await setup();
  const started = await initial.beginAttempt(row.approval.id, row.before);
  await initial.finishAttempt(started.attempt.id, { outcome: 'uncertain' });
  const app = await Pactspan.restore(nearNodes(initial.snapshot(), WORKSPACE_LIMITS.soft.nodes + 20), { clock });
  let afterFirst;
  for (let index = 0; index < 30; index++) {
    assert.equal((await app.reconcileAttempt(started.attempt.id, await observed('O1', '15000', String(index + 2)))).resolved, false);
    if (index === 0) afterFirst = workspaceUsage(app.snapshot());
  }
  const state = app.snapshot();
  assert.equal(state.events.filter(item => item.action === 'attempt_reconciled').length, 1);
  assert.equal(workspaceUsage(state).nodes, afterFirst.nodes);
  assert.equal(state.attempts[started.attempt.id].reconciliation_checks, 30);
  assert.equal(state.attempts[started.attempt.id].first_reconciliation.observation.revision, '2');
  assert.equal(state.attempts[started.attempt.id].last_reconciliation.observation.revision, '31');
  assert.equal((await app.verify(row.version.id, await observed('O1', '12000', '32'))).matched, true);
  assert.equal(app.snapshot().events.filter(item => item.action === 'attempt_reconciled').length, 2);
  assert.equal(Object.keys(app.snapshot().receipts).length, 1);
});

test('matching reconciliation settles pending exclusion while retaining late-ACK and verification reserves above soft', async () => {
  const { app: initial, rows: [row] } = await setup();
  const started = await initial.beginAttempt(row.approval.id, row.before);
  const app = await Pactspan.restore(nearNodes(initial.snapshot(), WORKSPACE_LIMITS.soft.nodes + 20), { clock });
  const after = await observed('O1', '12000', '2');
  await app.reconcileAttempt(started.attempt.id, after);
  assert.equal(app.view(row.version.id).unresolved_attempts.length, 0);
  assert.equal(app.snapshot().attempts[started.attempt.id].outcome, null);
  assert.equal(workspaceSettlementEligible(app.snapshot(), { settleAttempt: started.attempt.id }), true);
  assert.equal(workspaceSettlementEligible(app.snapshot(), { verifyVersion: row.version.id }), true);
  await app.finishAttempt(started.attempt.id, { outcome: 'acknowledged' });
  assert.equal((await app.verify(row.version.id, after)).matched, true);
});

test('a matching verification before ACK spends its receipt reserve once while finish remains eligible', async () => {
  const { app: initial, rows: [row] } = await setup();
  const started = await initial.beginAttempt(row.approval.id, row.before);
  const app = await Pactspan.restore(nearNodes(initial.snapshot(), WORKSPACE_LIMITS.soft.nodes + 20), { clock });
  assert.equal((await app.verify(row.version.id, await observed('O1', '12000', '2'))).matched, true);
  const saved = app.snapshot();
  assert.equal(workspaceSettlementEligible(saved, { verifyVersion: row.version.id }), false);
  assert.equal(workspaceSettlementEligible(saved, { settleAttempt: started.attempt.id }), true);
  await assert.rejects(app.verify(row.version.id, await observed('O1', '12000', '3')), /growth capacity/);
  assert.deepEqual(app.snapshot(), saved);
  await app.finishAttempt(started.attempt.id, { outcome: 'acknowledged' });
  assert.equal(Object.keys(app.snapshot().receipts).length, 1);
  assert.equal(app.snapshot().attempts[started.attempt.id].state, 'recorded');
});

test('ACK nonmatch retains only one verification reserve and consumes it without inventing fulfillment', async () => {
  const { app: initial, rows: [row] } = await setup();
  const started = await initial.beginAttempt(row.approval.id, row.before);
  const app = await Pactspan.restore(nearNodes(initial.snapshot(), WORKSPACE_LIMITS.soft.nodes + 20), { clock });
  await app.finishAttempt(started.attempt.id, { outcome: 'acknowledged' });
  const after = await observed('O1', '15000', '2');
  assert.equal((await app.reconcileAttempt(started.attempt.id, after)).resolved, true);
  assert.equal((await app.verify(row.version.id, after)).matched, false);
  assert.equal(app.snapshot().attempts[started.attempt.id].capacity_settled, true);
  assert.equal(app.view(row.version.id).unresolved_attempts.length, 0);
  assert.equal(Object.keys(app.snapshot().receipts).length, 0);
  const saved = app.snapshot();
  await assert.rejects(app.verify(row.version.id, await observed('O1', '15000', '3')), /growth capacity/);
  assert.deepEqual(app.snapshot(), saved);
});

test('an old reconciled attempt cannot spend the current attempt verification reserve', async () => {
  const { app: initial, rows: [row] } = await setup();
  const old = await initial.beginAttempt(row.approval.id, row.before);
  await initial.finishAttempt(old.attempt.id, { outcome: 'acknowledged' });
  const mismatch = await observed('O1', '15000', '2');
  await initial.reconcileAttempt(old.attempt.id, mismatch);
  const approved = await initial.approve(row.version.id, mismatch, { actor: 'manager', expires_at: '2030-01-08T09:11:00Z' });
  const current = await initial.beginAttempt(approved.id, mismatch);
  const app = await Pactspan.restore(nearNodes(initial.snapshot(), WORKSPACE_LIMITS.soft.nodes + 20), { clock });
  const matched = await observed('O1', '12000', '3');
  const saved = app.snapshot();
  assert.equal(workspaceSettlementEligible(saved, { verifyVersion: row.version.id, verifyAttempt: old.attempt.id }), false);
  assert.equal(workspaceSettlementEligible(saved, { verifyVersion: row.version.id, verifyAttempt: current.attempt.id }), true);
  await assert.rejects(app.verify(row.version.id, matched, { attemptId: old.attempt.id }), /growth capacity/);
  assert.deepEqual(app.snapshot(), saved);
  await app.finishAttempt(current.attempt.id, { outcome: 'acknowledged' });
  assert.equal((await app.verify(row.version.id, matched, { attemptId: current.attempt.id })).matched, true);
  assert.equal(Object.keys(app.snapshot().receipts).length, 1);
});

test('an older reconciled pending attempt cannot spend the latest writer reserve', async () => {
  const { app: initial, rows: [oldRow, nextRow] } = await setup(['O1', 'O2']);
  const old = await initial.beginAttempt(oldRow.approval.id, oldRow.before);
  await initial.reconcileAttempt(old.attempt.id, await observed('O1', '12000', '2'));
  const next = await initial.beginAttempt(nextRow.approval.id, nextRow.before);
  const app = await Pactspan.restore(nearNodes(initial.snapshot(), WORKSPACE_LIMITS.soft.nodes + 20), { clock });
  const saved = app.snapshot();
  assert.equal(workspaceSettlementEligible(saved, { settleAttempt: old.attempt.id }), false);
  assert.equal(workspaceSettlementEligible(saved, { settleAttempt: next.attempt.id }), true);
  await assert.rejects(app.finishAttempt(old.attempt.id, { outcome: 'acknowledged' }), /growth capacity/);
  assert.deepEqual(app.snapshot(), saved);
  await app.finishAttempt(next.attempt.id, { outcome: 'acknowledged' });
  assert.equal(app.snapshot().attempts[next.attempt.id].state, 'recorded');
});

test('reported bytes count serialized UTF-8 and the hard domain byte limit also applies on restore', async () => {
  const { app } = await setup();
  const state = app.snapshot();
  state.events.push({ ...historical(state), detail: '\u00e9"\n' });
  assert.equal(workspaceUsage(state).bytes, Buffer.byteLength(JSON.stringify(state), 'utf8'));
  const tooLarge = nearBytes(state, WORKSPACE_LIMITS.hard.bytes + 1);
  await assert.rejects(Pactspan.restore(tooLarge), /hard capacity/);
});
