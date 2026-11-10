import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceController } from '../src/local/controller.mjs';
import { beforeState } from '../src/core/terms.mjs';

const clock = () => '2030-01-08T10:00:00.000Z';
const expires_at = '2030-01-08T10:15:00Z';
const running = child => child.exitCode === null && child.signalCode === null;
async function kill(child) {
  if (!running(child)) return;
  const ended = once(child, 'exit');
  child.kill('SIGKILL');
  await ended;
}

async function interrupted(t, phase) {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'pactspan-crash-reconcile-'));
  const controller = await WorkspaceController.open({ directory, clock });
  await controller.dispatch('loadExample', { id: 'D01' });
  const candidate = Object.values(controller.snapshot().domain.candidates)[0];
  const version = (await controller.dispatch('confirm', { candidate_id: candidate.id, options: { actor: 'manager' } })).version;
  const before = await controller.dispatch('read', { entity_id: 'O1' });
  const approval = await controller.dispatch('approve', { version_id: version.id, reviewed: beforeState(before), options: { actor: 'manager', expires_at } });
  await controller.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/interrupted-controller.mjs', import.meta.url)), directory, approval.id, phase],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => kill(child));
  let marker;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && running(child)) {
    try { marker = JSON.parse(await readFile(path.join(directory, 'interruption-ready.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(marker?.phase, phase, stderr || 'Child never reached the interruption point');
  assert.equal(marker.pid, child.pid);
  const saved = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  const attempt = Object.values(saved.domain.attempts)[0];
  assert.equal(attempt.state, 'pending'); assert.equal(attempt.outcome, null);
  assert.equal(saved.domain.approvals[approval.id].state, 'consumed');
  await kill(child);
  assert.equal(running(child), false);
  return { directory, version, approval, attempt };
}

test('matching reconciliation after a real process death settles a committed pending write without inventing an ACK, and permits the next explicit write', async t => {
  const fixture = await interrupted(t, 'committed');
  const controller = await WorkspaceController.open({ directory: fixture.directory, clock });
  try {
    const before = controller.snapshot();
    assert.equal(before.crm.records.find(row => row.entity_id === 'O1').amount, '10800');
    assert.equal(before.crm.ledger.filter(row => row.kind === 'approved_write').length, 1);
    const reconciled = await controller.dispatch('reconcile', { attempt_id: fixture.attempt.id });
    assert.equal(reconciled.matched, true); assert.equal(reconciled.resolved, true);
    assert.equal(controller.snapshot().domain.attempts[fixture.attempt.id].outcome, null);
    assert.equal(Object.keys(controller.snapshot().domain.receipts).length, 0);
    const verified = await controller.dispatch('verify', { version_id: fixture.version.id });
    assert.equal(verified.matched, true); assert.equal(verified.version.status, 'fulfilled');
    const quote = 'Morgan will record USD 10500 on O1 instead of the prior amount.';
    const source = (await controller.dispatch('importSource', { document: { participants: [{ speaker: 'Morgan', person_id: 'morgan' }],
      segments: [{ speaker: 'Morgan', start_secs: 0, end_secs: 5, text: quote }] } })).source;
    const candidate = (await controller.dispatch('propose', { candidate: { agreement: 'accepted',
      terms: { kind: 'crm.amount', entity_id: 'O1', amount: '10500', currency: 'USD', owner: 'morgan' },
      evidence: [{ source: source.id, segment: 0, quote }] } })).candidate;
    const next = (await controller.dispatch('confirm', { candidate_id: candidate.id, options: { actor: 'manager', replaces: fixture.version.id } })).version;
    const observed = await controller.dispatch('read', { entity_id: 'O1' });
    const approval = await controller.dispatch('approve', { version_id: next.id, reviewed: beforeState(observed), options: { actor: 'manager', expires_at } });
    const result = await controller.dispatch('execute', { approval_id: approval.id });
    assert.equal(result.attempt.outcome, 'acknowledged');
    assert.equal(controller.snapshot().crm.records.find(row => row.entity_id === 'O1').amount, '10500');
    assert.equal(controller.snapshot().crm.ledger.filter(row => row.kind === 'approved_write').length, 2);
    assert.equal(Object.keys(controller.snapshot().domain.receipts).length, 1);
    const replay = await controller.dispatch('execute', { approval_id: fixture.approval.id });
    assert.equal(replay.reconcile, true);
    assert.equal(controller.snapshot().crm.ledger.filter(row => row.kind === 'approved_write').length, 2);
  } finally { await controller.close(); }
});

test('a nonmatching read after process death still blocks a pending write until explicit operator quiescence', async t => {
  const fixture = await interrupted(t, 'not-sent');
  const controller = await WorkspaceController.open({ directory: fixture.directory, clock });
  try {
    const result = await controller.dispatch('reconcile', { attempt_id: fixture.attempt.id });
    assert.equal(result.matched, false); assert.equal(result.resolved, false);
    const observed = await controller.dispatch('read', { entity_id: 'O1' });
    await assert.rejects(controller.dispatch('approve', { version_id: fixture.version.id, reviewed: beforeState(observed),
      options: { actor: 'manager', expires_at } }), /unsettled|reconcil/i);
    await controller.dispatch('closeAttempt', { attempt_id: fixture.attempt.id, options: { actor: 'operator', writer_quiesced: true,
      reason: 'The isolated test process was killed before its external update; no request remains active' } });
    const approval = await controller.dispatch('approve', { version_id: fixture.version.id, reviewed: beforeState(observed),
      options: { actor: 'manager', expires_at: '2030-01-08T10:20:00Z' } });
    assert.notEqual(approval.id, fixture.approval.id);
    assert.equal(controller.snapshot().crm.ledger.filter(row => row.kind === 'approved_write').length, 0);
    assert.equal(Object.keys(controller.snapshot().domain.receipts).length, 0);
  } finally { await controller.close(); }
});
