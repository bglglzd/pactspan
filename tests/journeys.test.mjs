import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { runJourney, runJourneys } from '../src/evaluation/journeys.mjs';

const directory = new URL('../examples/development/', import.meta.url);
const cases = await Promise.all((await readdir(directory)).filter(name => /^D\d\d\.json$/.test(name)).sort()
  .map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
const byId = id => structuredClone(cases.find(item => item.id === id));
const failures = report => JSON.stringify({ steps: report.steps.filter(step => !step.pass), final: report.final.assertions.filter(row => !row.pass) });

for (const fixture of cases) test(`authored development journey ${fixture.id} (${fixture.language})`, async () => {
  const report = await runJourney(fixture);
  assert.equal(report.automatic_extraction, false);
  assert.equal(report.steps.length, fixture.journey.length);
  assert.equal(report.pass, true, failures(report));
});

test('D01 records real before/write/ACK/reader evidence, not only lifecycle labels', async () => {
  const report = await runJourney(byId('D01'));
  const execute = report.steps.find(step => step.input.action === 'execute_action');
  assert.equal(execute.before.external.records[0].amount, '12000');
  assert.equal(execute.after.external.records[0].amount, '10800');
  assert.equal(execute.after.external.ledger[0].kind, 'approved_write');
  assert.equal(Object.values(execute.after.domain.versions)[0].status, 'confirmed');
  assert.equal(Object.keys(execute.after.domain.receipts).length, 0);
  const verified = report.steps.at(-1);
  const receipt = Object.values(verified.after.domain.receipts)[0];
  assert.equal(receipt.observation.amount, '10800');
  assert.equal(receipt.observation.revision, '8');
  assert.equal(receipt.version_id, Object.keys(verified.after.domain.versions)[0]);
});

test('changed oracle and invented reader fields fail without seeding the external store', async () => {
  const fixture = byId('D01');
  fixture.expected.crm[0].amount = '1';
  fixture.journey.find(step => step.action === 'observe_crm').observation.amount = '99999';
  const report = await runJourney(fixture);
  assert.equal(report.pass, false);
  assert.equal(report.final.external.records[0].amount, '10800');
  const observed = report.steps.find(step => step.input.action === 'observe_crm');
  assert.equal(observed.operation.observed.amount, '12000');
  assert.ok(observed.assertions.some(row => row.name === 'actual reader amount' && !row.pass));
  assert.ok(report.final.assertions.some(row => row.name === 'external final business state' && !row.pass));
});

test('missing action implementation and a broken dependency remain explicit failures', async () => {
  const fixture = byId('D01');
  fixture.journey.splice(3, 1);
  fixture.journey.push({ action: 'unsupported_future_tool' });
  const report = await runJourney(fixture);
  assert.equal(report.pass, false);
  assert.equal(report.steps.find(step => step.input.action === 'execute_action').operation.status, 'blocked');
  assert.equal(report.steps.at(-1).operation.status, 'unimplemented');
  assert.equal(report.final.counts.logical_writes, 0);
});

test('gold truth about conditions never becomes a manager attestation', async () => {
  const report = await runJourney(byId('D02'));
  assert.deepEqual(Object.values(report.final.domain.versions)[0].condition_decisions, {});
  assert.equal(report.final.counts.logical_writes, 0);
  assert.equal(report.final.counts.logical_fulfillments, 0);
  assert.ok(report.steps.flatMap(step => step.calls).every(call => call.method !== 'Pactspan.decideCondition'));
});

test('timeout-after-write physically commits once and restores the persisted attempt before send', async () => {
  const report = await runJourney(byId('D19'));
  assert.equal(report.pass, true, failures(report));
  const execute = report.steps.find(step => step.input.outcome === 'timeout_after_write');
  const order = execute.calls.map(call => call.method);
  assert.ok(order.indexOf('Pactspan.restore before send') < order.indexOf('DemoCRM.updateAmount'));
  assert.equal(execute.operation.persisted_before_send.state, 'pending');
  assert.equal(execute.after.external.records[0].revision, 21);
  assert.equal(Object.values(execute.after.domain.attempts)[0].outcome, 'uncertain');
  assert.equal(Object.keys(execute.after.domain.receipts).length, 0);
  assert.equal(report.final.counts.persisted_attempts, 1);
  assert.equal(report.final.counts.logical_writes, 1);
});

test('changed payload is refused at the declared driver boundary before any command/write', async () => {
  const fixture = byId('D01');
  fixture.journey = fixture.journey.slice(0, 5);
  fixture.journey.at(-1).payload = { entity_id: 'O1', amount: '10900', currency: 'USD' };
  fixture.journey.at(-1).refusal_reason = 'approved_payload_mismatch';
  delete fixture.journey.at(-1).result_revision;
  fixture.expected.commitments[0].state = 'confirmed';
  fixture.expected.commitments[0].receipt_count = 0;
  fixture.expected.crm = structuredClone(fixture.crm_initial);
  fixture.expected.logical_writes = 0;
  fixture.expected.logical_fulfillments = 0;
  const report = await runJourney(fixture);
  assert.equal(report.pass, true, failures(report));
  assert.equal(report.final.counts.persisted_attempts, 0);
  assert.equal(report.final.external.ledger.length, 0);
  assert.equal(report.steps.at(-1).calls[0].origin, 'driver, not a core API method');
});

test('declared approval scope cannot silently select a different core payload', async () => {
  const fixture = byId('D01');
  fixture.journey.find(step => step.action === 'approve_action').amount = '1';
  const report = await runJourney(fixture);
  assert.equal(report.pass, false);
  assert.equal(report.steps.find(step => step.input.action === 'approve_action').operation.error.code, 'requested_terms_mismatch');
  assert.equal(report.final.counts.logical_writes, 0);
});

test('proposed version labels remain previews and an incorrect allocated number fails', async () => {
  const proposed = await runJourney(byId('D17'));
  const second = proposed.final.annotations.find(item => item.annotation === 'D17-A2');
  assert.equal(second.version_id, null);
  assert.equal(second.number, null);
  assert.equal(second.next_version_preview, 2);
  const fixture = byId('D01'); fixture.journey[1].version = 42;
  const report = await runJourney(fixture);
  assert.equal(report.pass, false);
  assert.equal(Object.values(report.final.domain.versions)[0].number, 1);
});

test('batch report keeps all unique cases and rejects duplicate IDs', async () => {
  const report = await runJourneys([byId('D03'), byId('D04')]);
  assert.equal(report.pass, true);
  assert.deepEqual(report.results.map(item => item.case_id), ['D03', 'D04']);
  await assert.rejects(runJourneys([byId('D03'), byId('D03')]), /unique authored case IDs/);
});

test('a different guard error cannot satisfy the expected refusal', async () => {
  const fixture = byId('D05');
  fixture.journey.find(step => step.action === 'confirm').refusal_reason = 'approval_expired';
  const report = await runJourney(fixture);
  assert.equal(report.pass, false);
  assert.match(report.steps.find(step => step.input.action === 'confirm').operation.error.message, /Owner requires clarification/);
});

test('an unsupported oracle field is reported rather than silently waived', async () => {
  const fixture = byId('D01'); fixture.expected.customer_email_sent = true;
  const report = await runJourney(fixture);
  assert.equal(report.pass, false);
  assert.ok(report.final.assertions.some(row => row.name === 'no unimplemented final oracle fields' && !row.pass));
});
