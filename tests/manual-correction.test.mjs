import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { WorkspaceController } from '../src/local/controller.mjs';
import { WorkspaceStore } from '../src/local/store.mjs';

const AT = '2030-01-08T09:00:00Z';
const clock = () => AT;
const reason = 'Reviewed the original speakers and the complete deadline wording';
const evidence = candidate => candidate.evidence.map(span => Object.fromEntries(['source', 'segment', 'quote', 'start', 'end']
  .filter(key => Object.hasOwn(span, key)).map(key => [key, span[key]])));
const rawOf = candidate => ({ agreement: candidate.agreement, terms: structuredClone(candidate.terms),
  unknown_fields: [...candidate.unknown_fields], evidence: evidence(candidate) });

async function seed({ owner = null, amount = '10800' } = {}) {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'pactspan-correction-'));
  let controller = await WorkspaceController.open({ directory, clock });
  const quotes = ['🧩 I will record USD 10800 on O1 tomorrow by 17:00 UTC if Finance approves.', 'Agreed: Alex will make that update after approval.'];
  const source = (await controller.dispatch('importSource', { document: { title: 'Authored synthetic correction test',
    meeting_at: AT, time_zone: 'UTC', participants: [{ speaker: 'Alex', person_id: 'alex' }, { speaker: 'Nina', person_id: 'nina' }],
    segments: quotes.map((text, index) => ({ speaker: index ? 'Nina' : 'Alex', start_secs: index * 10, end_secs: index * 10 + 5, text })) } })).source;
  const original = (await controller.dispatch('propose', { candidate: { agreement: 'accepted',
    terms: { kind: 'crm.amount', entity_id: 'O1', amount, currency: 'USD', owner, statement: 'Record the agreed CRM amount',
      due: { literal: 'tomorrow by 17:00 UTC', resolved: null, precision: 'unknown', zone: null },
      conditions: [{ literal: 'if Finance approves' }] }, unknown_fields: ['owner', 'due.resolved'],
    evidence: quotes.map((quote, segment) => ({ source: source.id, segment, quote })) } })).candidate;
  await controller.close();
  // This is an authored saved-run fixture, not an extractor invocation or accuracy evidence.
  const store = await WorkspaceStore.open(directory, { clock });
  const saved = await store.load();
  saved.metadata.labels[original.id] = { origin: 'Model candidate', run_id: 'run_synthetic', raw_index: 0 };
  saved.metadata.runs = [{ id: 'run_synthetic', source_id: source.id, status: 'complete', raw_candidate_count: 1, candidate_ids: [original.id] }];
  await store.save(saved); await store.close();
  const runBytes = JSON.stringify({ schema_version: 1, id: 'run_synthetic', source_id: source.id,
    result: { provenance: 'Authored synthetic model-run fixture; no model call', candidates: [{ raw_index: 0, raw: rawOf(original) }] } }) + '\n';
  await writeFile(path.join(directory, 'runs', 'run_synthetic.json'), runBytes);
  controller = await WorkspaceController.open({ directory, clock });
  return { directory, controller, original, source, runBytes };
}

function corrected(original) {
  const raw = rawOf(original); raw.terms.owner = 'alex'; raw.terms.amount = '10800';
  raw.terms.due = { literal: 'tomorrow by 17:00 UTC', resolved: '2030-01-09T17:00:00Z', precision: 'instant', zone: 'UTC' };
  return raw;
}

test('manual correction creates a separate unconfirmed candidate, retaining all citations, unknowns and original run across restart', async () => {
  const fixture = await seed(); let controller = fixture.controller;
  try {
    const before = controller.snapshot(); const raw = corrected(fixture.original);
    const result = await controller.dispatch('propose', { candidate: raw, corrects: fixture.original.id, reason });
    assert.notEqual(result.candidate.id, fixture.original.id);
    assert.equal(result.candidate.state, 'proposed'); assert.equal(result.candidate.version_id, null);
    assert.equal(result.candidate.terms.owner, 'alex');
    assert.equal(result.candidate.terms.due.resolved, '2030-01-09T17:00:00.000Z');
    assert.deepEqual(result.candidate.unknown_fields, ['due.resolved', 'owner']);
    assert.deepEqual(result.candidate.evidence, fixture.original.evidence);
    const after = controller.snapshot();
    assert.deepEqual(after.domain.candidates[fixture.original.id], before.domain.candidates[fixture.original.id]);
    assert.deepEqual(after.domain.sources, before.domain.sources);
    assert.deepEqual(after.metadata.labels[fixture.original.id], before.metadata.labels[fixture.original.id]);
    assert.deepEqual(after.metadata.runs, before.metadata.runs);
    assert.deepEqual(after.metadata.labels[result.candidate.id], { origin: 'Manual correction', corrects: fixture.original.id, reason, actor: 'manager' });
    assert.equal(Object.keys(after.domain.versions).length, 0); assert.equal(Object.keys(after.domain.approvals).length, 0);
    assert.equal(Object.keys(after.domain.receipts).length, 0);
    assert.equal(await readFile(path.join(fixture.directory, 'runs', 'run_synthetic.json'), 'utf8'), fixture.runBytes);
    await controller.close(); controller = await WorkspaceController.open({ directory: fixture.directory, clock });
    assert.deepEqual(controller.snapshot().domain, after.domain);
    assert.deepEqual(controller.snapshot().metadata, after.metadata);
  } finally { await controller.close(); }
});

test('correcting a confirmed version does not change it; separate confirmation records the reason and explicit replacement', async () => {
  const { controller, original } = await seed({ owner: 'alex', amount: '12000' });
  try {
    const oldVersion = (await controller.dispatch('confirm', { candidate_id: original.id, options: { actor: 'manager' } })).version;
    const before = controller.snapshot(); const raw = corrected(original); raw.unknown_fields = [];
    const result = await controller.dispatch('propose', { candidate: raw, corrects: original.id, reason });
    const afterProposal = controller.snapshot();
    assert.deepEqual(afterProposal.domain.candidates[original.id], before.domain.candidates[original.id]);
    assert.deepEqual(afterProposal.domain.versions[oldVersion.id], before.domain.versions[oldVersion.id]);
    assert.equal(Object.keys(afterProposal.domain.versions).length, 1);
    for (const invalidReason of ['', 'x', '   ']) {
      await assert.rejects(controller.dispatch('confirm', { candidate_id: result.candidate.id,
        options: { actor: 'manager', reason: invalidReason, replaces: oldVersion.id } }), /reason|characters/);
      assert.deepEqual(controller.snapshot().domain, afterProposal.domain);
    }
    const next = (await controller.dispatch('confirm', { candidate_id: result.candidate.id,
      options: { actor: 'manager', replaces: oldVersion.id } })).version;
    assert.equal(next.confirmation.reason, reason); assert.equal(next.supersedes, oldVersion.id);
    assert.equal(next.status, 'confirmed'); assert.equal(controller.snapshot().domain.versions[oldVersion.id].status, 'superseded');
    assert.equal(Object.keys(controller.snapshot().domain.approvals).length, 0);
    assert.equal(Object.keys(controller.snapshot().domain.receipts).length, 0);
  } finally { await controller.close(); }
});

test('correction provenance and exact citation boundary reject invalid references, reasons and injected metadata without a storage fault', async () => {
  const { controller, directory, original } = await seed();
  try {
    const before = controller.snapshot(), rawState = await readFile(path.join(directory, 'state.json'), 'utf8');
    const valid = () => ({ candidate: corrected(original), corrects: original.id, reason });
    const cases = [
      args => { args.corrects = 'missing'; }, args => { args.corrects = 'constructor'; },
      args => { args.reason = '  x '; }, args => { delete args.reason; }, args => { delete args.corrects; },
      args => { args.candidate.evidence.pop(); }, args => { args.candidate.evidence[0].quote = 'Invented quote'; },
      args => { args.candidate.evidence[0].start++; }, args => { args.candidate.evidence[0].source = 'another-source'; },
      args => { args.candidate.terms.due.literal = 'Invented deadline'; },
      args => { args.candidate.terms.conditions = [{ literal: 'Invented prerequisite' }]; },
      args => { args.candidate.corrects = original.id; }, args => { args.actor = 'model'; },
    ];
    for (const change of cases) {
      const args = valid(); change(args); await assert.rejects(controller.dispatch('propose', args));
      assert.deepEqual(controller.snapshot(), before);
      assert.equal(await readFile(path.join(directory, 'state.json'), 'utf8'), rawState);
    }
    assert.equal(controller.snapshot().storage_error, null);
  } finally { await controller.close(); }
});

test('a duplicate correction preserves the first origin and existing raw-run references', async () => {
  const { controller, original } = await seed();
  try {
    const raw = corrected(original); raw.unknown_fields = [];
    const existing = (await controller.dispatch('propose', { candidate: raw })).candidate;
    const before = controller.snapshot();
    const repeated = await controller.dispatch('propose', { candidate: raw, corrects: original.id, reason });
    assert.equal(repeated.duplicate, true); assert.equal(repeated.candidate.id, existing.id);
    assert.deepEqual(controller.snapshot().metadata.labels[existing.id], before.metadata.labels[existing.id]);
    assert.equal(controller.snapshot().metadata.labels[existing.id].origin, 'Manual candidate');
    const noop = await controller.dispatch('propose', { candidate: rawOf(original), corrects: original.id, reason });
    assert.equal(noop.duplicate, true);
    assert.deepEqual(controller.snapshot().metadata.labels[original.id], before.metadata.labels[original.id]);
    assert.deepEqual(controller.snapshot().metadata.runs, before.metadata.runs);
    assert.deepEqual(controller.snapshot().domain.candidates[original.id], before.domain.candidates[original.id]);
  } finally { await controller.close(); }
});

test('generic corrected promises remain trackable without amount or currency and still require separate confirmation', async () => {
  for (const kind of ['other', 'proposal.sent']) {
    const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'pactspan-correction-generic-'));
    const controller = await WorkspaceController.open({ directory, clock });
    try {
      const quote = kind === 'other' ? 'Alex will send the security questionnaire for O1.' : 'Alex will send the proposal for O1.';
      const source = (await controller.dispatch('importSource', { document: { title: 'Authored generic correction test',
        participants: [{ speaker: 'Alex', person_id: 'alex' }], segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 5, text: quote }] } })).source;
      const original = (await controller.dispatch('propose', { candidate: { agreement: 'accepted',
        terms: { kind, entity_id: 'O1', owner: null, amount: null, currency: null, statement: quote },
        evidence: [{ source: source.id, segment: 0, quote }] } })).candidate;
      const raw = rawOf(original); raw.terms.owner = 'alex'; raw.unknown_fields = ['amount', 'currency', 'due'];
      const next = (await controller.dispatch('propose', { candidate: raw, corrects: original.id, reason: 'The quoted action names Alex as its owner' })).candidate;
      assert.equal(next.state, 'proposed'); assert.equal(next.terms.kind, kind);
      assert.equal(next.terms.amount, null); assert.equal(next.terms.currency, null);
      const confirmed = (await controller.dispatch('confirm', { candidate_id: next.id, options: { actor: 'manager' } })).version;
      assert.equal(confirmed.status, 'confirmed'); assert.ok(confirmed.confirmation.reason);
      assert.equal(Object.keys(controller.snapshot().domain.receipts).length, 0);
    } finally { await controller.close(); }
  }
});
