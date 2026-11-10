import test from 'node:test';
import assert from 'node:assert/strict';
import { Pactspan, invariantErrors } from '../src/core/engine.mjs';
import { sha256 } from '../src/core/data.mjs';

const TARGET = { adapter: 'demo', mode: 'synthetic', origin: 'demo://crm' };
const OTHER_TARGET = { adapter: 'espocrm', mode: 'single-writer-sandbox', origin: 'http://127.0.0.1:49561' };
const options = { clock: () => '2030-01-08T09:00:00Z' };
const kinds = ['other', 'proposal.sent'];

async function propose(app, kind, statement, entity = 'O1', extra = {}) {
  const source = (await app.importSource({ title: 'Authored grouping test', participants: [{ speaker: 'Alex', person_id: 'alex' }],
    segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 5, text: statement }] })).source;
  return (await app.propose({ agreement: 'accepted', evidence: [{ source: source.id, segment: 0, quote: statement }],
    terms: { kind, entity_id: entity, owner: 'alex', amount: null, currency: null, statement, ...extra } })).candidate;
}
async function confirm(app, candidate, relationship = {}, target = TARGET) {
  return (await app.confirm(candidate.id, { actor: 'manager', target, ...relationship })).version;
}

test('unrelated other and proposal.sent promises on the same entity remain independent confirmed commitments', async () => {
  for (const kind of kinds) {
    const app = new Pactspan(undefined, options);
    const firstCandidate = await propose(app, kind, kind === 'other' ? 'Alex will send the security questionnaire for O1.' : 'Alex will send the initial proposal for O1.');
    const first = await confirm(app, firstCandidate);
    const secondCandidate = await propose(app, kind, kind === 'other' ? 'Alex will send a separate onboarding packet for O1.' : 'Alex will send a separate renewal proposal for O1.');
    const second = await confirm(app, secondCandidate);
    assert.notEqual(first.commitment_id, second.commitment_id);
    assert.deepEqual([app.view(first.id).status, app.view(second.id).status], ['confirmed', 'confirmed']);
    assert.deepEqual([first.number, second.number], [1, 1]);
    assert.equal(Object.keys(app.snapshot().commitments).length, 2);
    assert.equal(app.snapshot().events.filter(event => event.action === 'terms_conflict').length, 0);
    assert.deepEqual(app.view(first.id).terms, firstCandidate.terms);
    assert.deepEqual(app.view(second.id).terms, secondCandidate.terms);
    const restored = await Pactspan.restore(app.snapshot(), options);
    assert.deepEqual(restored.snapshot(), app.snapshot());
    assert.deepEqual(invariantErrors(restored.snapshot()), []);
    assert.equal((await app.confirm(firstCandidate.id, { actor: 'manager', target: TARGET })).duplicate, true);
    assert.equal(Object.keys(app.snapshot().commitments).length, 2);
  }
});

test('an explicitly linked generic replacement joins only the selected commitment and supersedes its current version', async () => {
  for (const kind of kinds) {
    const app = new Pactspan(undefined, options);
    const firstCandidate = await propose(app, kind, kind === 'other' ? 'Alex will send the initial questionnaire for O1.' : 'Alex will send the initial proposal for O1.');
    const first = await confirm(app, firstCandidate);
    const independent = await confirm(app, await propose(app, kind, kind === 'other' ? 'Alex will schedule the separate onboarding session for O1.' : 'Alex will send a separate renewal proposal for O1.'));
    const replacementCandidate = await propose(app, kind, kind === 'other' ? 'Alex will send the revised questionnaire for O1 instead.' : 'Alex will send the revised initial proposal for O1 instead.');
    const replacement = await confirm(app, replacementCandidate, { replaces: first.id });
    assert.equal(replacement.commitment_id, first.commitment_id);
    assert.equal(replacement.number, 2); assert.equal(replacement.supersedes, first.id);
    assert.equal(app.view(first.id).status, 'superseded');
    assert.equal(app.view(replacement.id).status, 'confirmed');
    assert.equal(app.view(independent.id).status, 'confirmed');
    assert.equal(Object.keys(app.snapshot().commitments).length, 2);
    assert.deepEqual(app.view(first.id).terms, firstCandidate.terms);
    assert.deepEqual(app.view(replacement.id).terms, replacementCandidate.terms);
    assert.deepEqual((await Pactspan.restore(app.snapshot(), options)).snapshot(), app.snapshot());
  }
});

test('related_to records an explicit generic conflict and leaves a separate promise untouched', async () => {
  for (const kind of kinds) {
    const app = new Pactspan(undefined, options);
    const first = await confirm(app, await propose(app, kind, kind === 'other' ? 'Alex will send the initial security questionnaire for O1.' : 'Alex will send the initial proposal for O1.'));
    const independent = await confirm(app, await propose(app, kind, kind === 'other' ? 'Alex will arrange an independent meeting for O1.' : 'Alex will send a separate renewal proposal for O1.'));
    const conflict = await confirm(app, await propose(app, kind, kind === 'other' ? 'Alex will send a different security questionnaire for O1.' : 'Alex will send a different initial proposal for O1.'), { related_to: first.id });
    assert.equal(conflict.commitment_id, first.commitment_id);
    assert.equal(conflict.number, 2); assert.equal(conflict.supersedes, null);
    assert.deepEqual([app.view(first.id).status, app.view(conflict.id).status], ['disputed', 'disputed']);
    assert.equal(app.view(first.id).dispute_kind, 'terms_conflict');
    assert.equal(app.view(conflict.id).dispute_kind, 'terms_conflict');
    assert.equal(app.view(independent.id).status, 'confirmed');
    assert.equal(app.snapshot().events.find(event => event.action === 'confirmed' && event.target === conflict.id).detail.related_to, first.id);
    await app.resolveConflict(first.id, { actor: 'manager', reason: 'Reviewed both alternatives and selected the initial terms' });
    assert.equal(app.view(first.id).status, 'confirmed');
    assert.equal(app.view(conflict.id).status, 'superseded');
    assert.equal(app.view(independent.id).status, 'confirmed');
    assert.deepEqual(invariantErrors(app.snapshot()), []);
  }
});

test('explicit relationships reject another kind, entity or CRM target without changing the workspace', async () => {
  for (const key of ['replaces', 'related_to']) {
    for (const incompatible of ['kind', 'entity', 'target']) {
      const app = new Pactspan(undefined, options);
      const first = await confirm(app, await propose(app, 'other', 'Alex will send the security questionnaire for O1.'));
      const candidate = await propose(app, incompatible === 'kind' ? 'proposal.sent' : 'other', 'Alex will perform a separately sourced action.', incompatible === 'entity' ? 'O2' : 'O1');
      const before = app.snapshot();
      await assert.rejects(confirm(app, candidate, { [key]: first.id }, incompatible === 'target' ? OTHER_TARGET : TARGET), /same kind, entity and CRM target/);
      assert.deepEqual(app.snapshot(), before);
    }
  }
});

test('a relation must name the current version and cannot request replacement and conflict together', async () => {
  for (const key of ['replaces', 'related_to']) {
    const app = new Pactspan(undefined, options);
    const first = await confirm(app, await propose(app, 'other', 'Alex will send the initial questionnaire for O1.'));
    const current = await confirm(app, await propose(app, 'other', 'Alex will send the revised questionnaire for O1 instead.'), { replaces: first.id });
    const candidate = await propose(app, 'other', 'Alex will send a third questionnaire for O1.');
    const before = app.snapshot();
    await assert.rejects(confirm(app, candidate, { [key]: first.id }), /current version/);
    await assert.rejects(confirm(app, candidate, { replaces: current.id, related_to: current.id }), /not both/);
    await assert.rejects(confirm(app, candidate, { [key]: '' }), /short ASCII identifier/);
    await assert.rejects(confirm(app, candidate, { [key]: 'missing' }), /Unknown commitment version/);
    assert.deepEqual(app.snapshot(), before);
    assert.equal(app.snapshot().candidates[candidate.id].state, 'proposed');
  }
});

test('crm.amount keeps automatic per-entity grouping and implicit conflict behavior', async () => {
  const app = new Pactspan(undefined, options);
  const first = await confirm(app, await propose(app, 'crm.amount', 'Alex will record USD 12000 on O1.', 'O1', { amount: '12000', currency: 'USD' }));
  const second = await confirm(app, await propose(app, 'crm.amount', 'Alex will record USD 10800 on O1.', 'O1', { amount: '10800', currency: 'USD' }));
  const expectedId = 'cmt_' + await sha256({ kind: 'crm.amount', entity: 'O1', target: TARGET });
  assert.equal(first.commitment_id, expectedId); assert.equal(second.commitment_id, expectedId);
  assert.deepEqual([first.number, second.number], [1, 2]);
  assert.deepEqual([app.view(first.id).status, app.view(second.id).status], ['disputed', 'disputed']);
  const third = await confirm(app, await propose(app, 'crm.amount', 'Alex will record USD 10000 on O1 instead.', 'O1', { amount: '10000', currency: 'USD' }), { replaces: second.id });
  assert.equal(third.commitment_id, expectedId); assert.equal(third.number, 3);
  assert.equal(app.view(first.id).status, 'disputed'); assert.equal(app.view(second.id).status, 'superseded'); assert.equal(app.view(third.id).status, 'disputed');
  assert.equal(Object.keys(app.snapshot().commitments).length, 1);
  assert.deepEqual((await Pactspan.restore(app.snapshot(), options)).snapshot(), app.snapshot());
});
