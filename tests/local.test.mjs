import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { WorkspaceController } from '../src/local/controller.mjs';
import { WorkspaceStore } from '../src/local/store.mjs';
import { startServer } from '../src/local/server.mjs';
import { EspoCRM } from '../src/adapters/espo.mjs';
import { beforeState } from '../src/core/terms.mjs';
import { buildDemo } from '../scripts/build-demo.mjs';

async function directory() { return mkdtemp(path.join(os.tmpdir(), 'pactspan-local-')); }
async function prepare(controller) {
  const quote = 'Alex agrees to record USD 10800 on O1.';
  const { source } = await controller.dispatch('importSource', { document: { title: 'Synthetic test meeting',
    participants: [{ speaker: 'Alex', person_id: 'alex' }], segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 3, text: quote }] } });
  const { candidate } = await controller.dispatch('propose', { candidate: { agreement: 'accepted',
    terms: { kind: 'crm.amount', entity_id: 'O1', amount: '10800', currency: 'USD', owner: 'alex' }, evidence: [{ source: source.id, segment: 0, quote }] } });
  const { version } = await controller.dispatch('confirm', { candidate_id: candidate.id, options: { actor: 'manager' } });
  const observed = await controller.dispatch('read', { entity_id: 'O1' });
  const approval = await controller.dispatch('approve', { version_id: version.id, reviewed: beforeState(observed),
    options: { actor: 'manager', expires_at: new Date(Date.parse(controller.snapshot().clock) + 600_000).toISOString() } });
  return { version, approval };
}

async function espoServer(t, directory, { uncertain = false } = {}) {
  const state = { amount: 12000, amountCurrency: 'USD', versionNumber: 1, puts: 0, reads: 0, keys: [], durable_before_put: [] };
  const server = http.createServer(async (request, response) => {
    state.keys.push({ method: request.method, key: request.headers['x-api-key'] });
    if (request.method === 'GET') {
      state.reads++; response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'O1', deleted: false, amount: state.amount, amountCurrency: state.amountCurrency, versionNumber: state.versionNumber })); return;
    }
    const saved = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
    state.durable_before_put.push(saved.domain);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const update = JSON.parse(Buffer.concat(chunks));
    assert.deepEqual(Object.keys(update).sort(), ['amount', 'amountCurrency']);
    assert.equal(request.headers['x-version-number'], String(state.versionNumber));
    state.puts++; state.amount = update.amount; state.amountCurrency = update.amountCurrency; state.versionNumber++;
    if (uncertain) { request.socket.destroy(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'O1', deleted: false, amount: state.amount, amountCurrency: state.amountCurrency, versionNumber: state.versionNumber }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const adapter = () => new EspoCRM({ origin, readKey: 'SYNTHETIC_READER_KEY', writeKey: 'SYNTHETIC_WRITER_KEY', singleWriter: true });
  return { state, adapter, target: { adapter: 'espocrm', mode: 'single-writer-sandbox', origin } };
}

test('local controller persists the one-use attempt before a real HTTP PUT and verifies through its reader after restart', async t => {
  const folder = await directory(); const { state, adapter, target } = await espoServer(t, folder);
  let controller = await WorkspaceController.open({ directory: folder, crm: adapter(), target });
  t.after(async () => controller.close());
  const { version, approval } = await prepare(controller);
  const written = await controller.dispatch('execute', { approval_id: approval.id });
  assert.equal(written.attempt.outcome, 'acknowledged'); assert.equal(written.requires_verification, true);
  assert.equal(state.puts, 1); assert.equal(state.amount, 10800);
  const durable = state.durable_before_put[0]; assert.equal(durable.approvals[approval.id].state, 'consumed');
  assert.equal(Object.values(durable.attempts)[0].state, 'pending'); assert.equal(Object.keys(durable.receipts).length, 0);
  assert.equal(controller.snapshot().domain.versions[version.id].status, 'confirmed');
  await controller.close(); controller = await WorkspaceController.open({ directory: folder, crm: adapter(), target });
  const readCount = state.reads;
  const verified = await controller.dispatch('verify', { version_id: version.id });
  assert.equal(state.reads, readCount + 1); assert.equal(verified.matched, true);
  assert.equal(verified.receipt.observation.revision, '2'); assert.equal(verified.receipt.version_id, version.id);
  await controller.dispatch('execute', { approval_id: approval.id }); assert.equal(state.puts, 1);
  assert.ok(state.keys.filter(row => row.method === 'GET').every(row => row.key === 'SYNTHETIC_READER_KEY'));
  assert.ok(state.keys.filter(row => row.method === 'PUT').every(row => row.key === 'SYNTHETIC_WRITER_KEY'));
  state.amount = 11000; state.versionNumber++;
  const rollback = await controller.dispatch('verify', { version_id: version.id });
  assert.equal(rollback.matched, false); assert.equal(rollback.version.status, 'disputed');
  assert.equal(Object.keys(controller.snapshot().domain.receipts).length, 1);
  const exported = await controller.export(); assert.ok(!exported.includes('SYNTHETIC_READER_KEY') && !exported.includes('SYNTHETIC_WRITER_KEY'));
});

test('lost HTTP acknowledgement persists uncertainty, refuses another write, then reconciles the committed effect', async t => {
  const folder = await directory(); const { state, adapter, target } = await espoServer(t, folder, { uncertain: true });
  let controller = await WorkspaceController.open({ directory: folder, crm: adapter(), target }); t.after(() => controller.close());
  const { version, approval } = await prepare(controller);
  const result = await controller.dispatch('execute', { approval_id: approval.id });
  assert.equal(result.attempt.outcome, 'uncertain'); assert.equal(state.puts, 1);
  assert.equal(Object.keys(controller.snapshot().domain.receipts).length, 0);
  const repeated = await controller.dispatch('execute', { approval_id: approval.id }); assert.equal(repeated.reconcile, true); assert.equal(state.puts, 1);
  const reconciliation = await controller.dispatch('reconcile', { attempt_id: result.attempt.id });
  assert.equal(reconciliation.resolved, true); assert.equal(reconciliation.matched, true);
  assert.equal(controller.snapshot().domain.versions[version.id].status, 'confirmed');
  await controller.dispatch('verify', { version_id: version.id }); assert.equal(state.puts, 1);
  assert.equal(controller.snapshot().domain.versions[version.id].status, 'fulfilled');
});

test('a failed durable attempt commit prevents the PUT and leaves the saved approval reusable', async t => {
  const folder = await directory(); const { state, adapter, target } = await espoServer(t, folder);
  let controller = await WorkspaceController.open({ directory: folder, crm: adapter(), target }); t.after(() => controller.close());
  const { approval } = await prepare(controller); const original = WorkspaceStore.prototype.save;
  const mocked = t.mock.method(WorkspaceStore.prototype, 'save', async function (value) {
    if (Object.keys(value.domain.attempts).length) throw new Error('Synthetic full disk'); return original.call(this, value);
  });
  await assert.rejects(controller.dispatch('execute', { approval_id: approval.id }), /Synthetic full disk/);
  assert.equal(state.puts, 0); assert.equal(controller.snapshot().domain.approvals[approval.id].state, 'approved');
  assert.equal(Object.keys(JSON.parse(await readFile(path.join(folder, 'state.json'), 'utf8')).domain.attempts).length, 0);
  mocked.mock.restore();
  await assert.rejects(controller.dispatch('execute', { approval_id: approval.id }), /restart/);
  await controller.close(); controller = await WorkspaceController.open({ directory: folder, crm: adapter(), target });
  await controller.dispatch('execute', { approval_id: approval.id }); assert.equal(state.puts, 1);
});

test('local HTTP authority is loopback/session/origin bound and clients cannot supply observations or raw write commands', async t => {
  const controller = await WorkspaceController.open({ directory: await directory() });
  const hosted = await startServer({ controller, staticRoot: await buildDemo() });
  t.after(async () => { await hosted.close(); await controller.close(); });
  const page = await fetch(hosted.origin); const html = await page.text(); const token = html.match(/name="pactspan-local-session" content="([a-f0-9]{64})"/)?.[1]; assert.ok(token);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(hosted.origin + '/api/workspace')).status, 403);
  assert.equal((await fetch(hosted.origin + '/api/workspace', { headers: { 'X-Pactspan-Token': token, Origin: 'http://other.invalid' } })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const request = http.get(hosted.origin + '/api/workspace', { headers: { 'X-Pactspan-Token': token, Host: 'rebound.invalid' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.once('error', reject);
  });
  assert.equal(rebound, 403);
  const post = (value, extra = {}) => fetch(hosted.origin + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pactspan-Token': token, Origin: hosted.origin, ...extra }, body: JSON.stringify(value) });
  assert.equal((await post({ action: 'loadExample', args: { id: 'D01' } }, { Origin: 'null' })).status, 403);
  const loaded = await post({ action: 'loadExample', args: { id: 'D01' } }); assert.equal(loaded.status, 200);
  const source = Object.keys((await loaded.json()).workspace.domain.sources)[0]; assert.ok(source);
  const observation = await post({ action: 'verify', args: { version_id: 'fake', observation: { amount: '10800' } } }); assert.equal(observation.status, 400);
  assert.equal((await post({ action: 'updateAmount', args: { entityId: 'O1', amount: '1' } })).status, 400);
  assert.equal((await post({ action: '__proto__', args: {} })).status, 400);
  assert.equal((await fetch(hosted.origin + '/src/local/controller.mjs')).status, 404);
  assert.equal((await fetch(hosted.origin + '/.pactspan/state.json')).status, 404);
});

test('synthetic local CRM is independently persisted; its external edit is visible after both stores restart', async t => {
  const folder = await directory(); let controller = await WorkspaceController.open({ directory: folder }); t.after(() => controller.close());
  await controller.dispatch('loadExample', { id: 'D01' });
  const candidate = Object.values(controller.snapshot().domain.candidates)[0];
  const { version } = await controller.dispatch('confirm', { candidate_id: candidate.id, options: { actor: 'manager' } });
  const before = await controller.dispatch('read', { entity_id: 'O1' });
  const approval = await controller.dispatch('approve', { version_id: version.id, reviewed: beforeState(before), options: { actor: 'manager', expires_at: '2030-01-08T10:15:00Z' } });
  await controller.dispatch('execute', { approval_id: approval.id }); await controller.dispatch('verify', { version_id: version.id });
  await controller.dispatch('operatorChange', { entity_id: 'O1', values: { amount: '11000' } });
  await controller.close(); controller = await WorkspaceController.open({ directory: folder });
  assert.equal((await controller.dispatch('read', { entity_id: 'O1' })).amount, '11000');
  assert.equal(controller.snapshot().domain.versions[version.id].status, 'fulfilled');
  const check = await controller.dispatch('verify', { version_id: version.id }); assert.equal(check.version.status, 'disputed');
  assert.equal(Object.keys(controller.snapshot().domain.receipts).length, 1);
});

test('local extraction retains every raw prediction but unmapped model ownership cannot enter confirmable domain candidates', async t => {
  const model = 'SYNTHETIC_LOCAL_MODEL'; const quote = 'Alex will record USD 10800 on O1.';
  const prediction = owner => ({ agreement: 'accepted', terms: { kind: 'crm.amount', entity_id: 'O1', amount: '10800', currency: 'USD',
    owner, statement: 'Record amount', due: null, conditions: [] }, unknown_fields: [], evidence: [{ segment: 0, quote, start: null, end: null }] });
  const modelServer = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); const source = JSON.parse(input.messages[1].content);
    assert.ok(!Object.hasOwn(source, 'annotations') && !Object.hasOwn(source, 'expected'));
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ model, choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ candidates: [prediction('invented'), prediction('alex')] }) } }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)); });
  const controller = await WorkspaceController.open({ directory: await directory(), extraction: { origin: `http://127.0.0.1:${modelServer.address().port}`, model } });
  t.after(() => controller.close());
  const { source } = await controller.dispatch('importSource', { document: { participants: [{ speaker: 'Alex', person_id: 'alex' }],
    segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 3, text: quote }] } });
  const extracted = await controller.dispatch('extract', { source_id: source.id });
  assert.equal(extracted.run.raw_candidate_count, 2); assert.equal(extracted.run.candidate_ids.length, 1);
  const domain = controller.snapshot().domain; assert.equal(Object.keys(domain.candidates).length, 1);
  assert.equal(Object.values(domain.candidates)[0].terms.owner, 'alex'); assert.equal(Object.keys(domain.versions).length, 0);
  const evidence = JSON.parse(await controller.runEvidence(extracted.run.id));
  assert.equal(evidence.result.candidates.length, 2); assert.equal(evidence.result.candidates[0].raw.terms.owner, 'invented');
  assert.equal(evidence.result.candidates[0].supported, false); assert.equal(evidence.result.candidates[1].supported, true);
});
