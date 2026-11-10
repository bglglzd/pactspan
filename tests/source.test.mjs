import test from 'node:test';
import assert from 'node:assert/strict';
import { citation, importedDocument, makeSource } from '../src/core/source.mjs';
import { canonical, instant } from '../src/core/data.mjs';

const document = () => ({ title: 'Synthetic terms', meeting_at: '2030-01-08T09:00:00Z', time_zone: 'Europe/Moscow',
  participants: [{ speaker: 'Alex', person_id: 'alex' }],
  segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 5, text: '📎 Согласовано: USD 10800. No email has been sent.' }] });

test('immutable source identity deduplicates exact context and binds source edits', async () => {
  const input = document();
  const source = await makeSource(input);
  assert.equal(source.id, (await makeSource(structuredClone(input))).id);
  input.segments[0].text = 'Changed terms';
  assert.notEqual(source.id, (await makeSource(input)).id);
  assert.match(source.segments[0].text, /Согласовано/);
});

test('exact bilingual quote offsets use UTF-16 and do not authenticate missing or repeated evidence', async () => {
  const source = await makeSource(document());
  const raw = { source: source.id, segment: 0, quote: 'Согласовано: USD 10800.' };
  const checked = citation(source, raw);
  assert.equal(checked.supported, true);
  assert.equal(checked.start, 3);
  assert.equal(source.segments[0].text.slice(checked.start, checked.end), raw.quote);
  assert.equal(citation(source, { ...raw, quote: 'USD 12000' }).supported, false);
  const repeated = await makeSource({ ...document(), segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 5, text: 'Yes. Yes.' }] });
  assert.equal(citation(repeated, { source: repeated.id, segment: 0, quote: 'Yes.' }).supported, false);
  assert.equal(citation(repeated, { source: repeated.id, segment: 0, quote: 'Yes.', start: 5, end: 9 }).supported, true);
});

test('unknown fields, invalid types/calendar/Unicode fail before source acceptance', async () => {
  for (const change of [input => { input.timezone = 'UTC'; }, input => { input.segments[0].text = '\ud800'; },
    input => { input.participants[0].person_id = []; }, input => { input.segments[0].end_secs = -1; }]) {
    const input = document(); change(input); await assert.rejects(makeSource(input));
  }
  assert.throws(() => instant('2030-02-30T12:00:00Z', 'deadline'), /calendar date/);
  assert.throws(() => canonical(JSON.parse('{"__proto__":{}}')), /reserved field/);
});

test('existing Auris segment JSON and timestamped TXT retain exact quoted text', async () => {
  const json = await makeSource(importedDocument(JSON.stringify({ segments: document().segments }), { title: 'JSON import' }));
  assert.equal(json.meeting_at, null);
  assert.equal(json.segments[0].text, document().segments[0].text);
  const txt = await makeSource(importedDocument('Synthetic meeting\n\n[0:04] Alex: Record USD 10800.\nOnly after approval.'));
  assert.equal(txt.segments[0].start_secs, 4);
  assert.equal(txt.segments[0].text, 'Record USD 10800.\nOnly after approval.');
  assert.equal(txt.original.text, 'Synthetic meeting\n\n[0:04] Alex: Record USD 10800.\nOnly after approval.');
  const changedHeader = await makeSource(importedDocument('Other heading\n\n[0:04] Alex: Record USD 10800.\nOnly after approval.'));
  assert.notEqual(txt.id, changedHeader.id);
  assert.throws(() => importedDocument('[]'), /transcript JSON must be an object/);
});
