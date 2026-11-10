import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeadline, deadlineUnknowns, DEADLINE_VERSION } from '../src/adapters/deadline.mjs';
import { instant } from '../src/core/data.mjs';
import { readFile, readdir } from 'node:fs/promises';

function resolve(literal, changes = {}) {
  return resolveDeadline({ literal, resolved: null, precision: 'unknown', zone: null }, {
    meeting_at: '2030-01-08T23:30:00Z', time_zone: 'Europe/Moscow', segments: [{ text: literal }], ...changes });
}
test('anchored relative deadlines use the meeting local day and exact explicit deadline zone', () => {
  const ru = resolve('завтра к 17:00 по Москве');
  assert.equal(ru.due.resolved, '2030-01-10T14:00:00.000Z'); assert.equal(ru.method, 'anchored-relative-instant');
  assert.equal(resolve('tomorrow by 17:00 London time').due.resolved, '2030-01-10T17:00:00.000Z');
  assert.equal(resolve('tomorrow', { meeting_at: null }).status, 'unresolved');
  assert.equal(resolve('tomorrow by 17:00', { time_zone: null }).status, 'unresolved');
});
test('absolute local deadlines refuse folds and gaps and never invent a date-only cutoff', () => {
  const fold = resolve('at 01:30 London time on 27 October 2030'); assert.equal(fold.due.resolved, null); assert.match(fold.reason, /more than once/);
  const gap = resolve('at 01:30 London time on 31 March 2030'); assert.equal(gap.due.resolved, null); assert.match(gap.reason, /does not exist/);
  const dated = resolve('on 27 October 2030', { time_zone: 'Europe/London' });
  assert.deepEqual(dated.due, { literal: 'on 27 October 2030', resolved: '2030-10-27', precision: 'date', zone: 'Europe/London' });
  assert.deepEqual(deadlineUnknowns(['due', 'owner'], dated), ['owner', 'due.cutoff'].sort());
});
test('exact grammar preserves half-hour/quarter-hour zones and explicit offsets without model date authority', () => {
  assert.equal(resolve('by 17:00 on 8 January 2030', { time_zone: 'Asia/Kathmandu' }).due.resolved, '2030-01-08T11:15:00.000Z');
  assert.equal(resolve('by 2030-01-08T17:00:00+05:30').due.resolved, '2030-01-08T11:30:00.000Z');
  const source = { meeting_at: null, time_zone: null, segments: [{ text: 'sometime in March' }] };
  assert.equal(resolveDeadline({ literal: 'sometime in March', resolved: '2030-03-01T00:00:00Z', precision: 'instant', zone: 'UTC' }, source).due.resolved, null);
  assert.deepEqual(deadlineUnknowns(['due', 'due.resolved', 'owner'], resolve('by 12:00 UTC on 8 January 2030')), ['owner']);
});
test('missing wording, invalid calendar, unstated years and ambiguous abbreviations remain explicit unknowns', () => {
  assert.equal(resolve('tomorrow', { segments: [{ text: 'Never stated' }] }).unsupported, true);
  for (const literal of ['by 17:00 on 30 February 2030', 'by 25:00 on 8 January 2030', 'next Friday', 'on 8 January', 'by 17:00 CST on 8 January 2030']) {
    assert.equal(resolve(literal).due.resolved, null, literal);
  }
  assert.equal(resolve('by 17:00 on 8 January 2030', { time_zone: null }).due.resolved, null);
  assert.throws(() => instant('2020-01-01T00:00:00+14:00', 'boundary'), /supported calendar range/);
  assert.throws(() => instant('2100-12-31T23:59:59-12:00', 'boundary'), /supported calendar range/);
});

test('Russian absolute dates accept optional года/г. without inventing a date-only cutoff', () => {
  assert.equal(DEADLINE_VERSION, 'pactspan-deadline-v2');
  for (const suffix of ['', ' года', ' г.']) {
    const timed = `до 18:00 по Москве 10 января 2030${suffix}`;
    assert.deepEqual(resolve(timed).due, { literal: timed, resolved: '2030-01-10T15:00:00.000Z', precision: 'instant', zone: 'Europe/Moscow' });
    const dated = `до 10 января 2030${suffix}`;
    assert.deepEqual(resolve(dated).due, { literal: dated, resolved: '2030-01-10', precision: 'date', zone: 'Europe/Moscow' });
  }
  for (const literal of ['до 18:00 по Москве 10 января года', 'до 18:00 по Москве 30 февраля 2030 года',
    'до 18:00 по Москве 10 января 2030 году', 'by 18:00 UTC on 10 January 2030 года', 'до 10 января 2030 года и позже']) {
    assert.equal(resolve(literal).due.resolved, null, literal);
  }
});

test('every prewritten development deadline matches independent gold from literal and source context only', async () => {
  const directory = new URL('../examples/development/', import.meta.url);
  for (const file of (await readdir(directory)).filter(name => /^D\d\d\.json$/.test(name)).sort()) {
    const fixture = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
    for (const annotation of fixture.annotations) {
      const source = fixture.sources.find(item => item.id === annotation.source);
      // Missing wording is canonical absence; resolved/precision/zone gold is
      // never passed into the resolver as model authority.
      const input = annotation.due?.literal ? { literal: annotation.due.literal, resolved: null, precision: 'unknown', zone: null } : null;
      const expected = input === null ? null : structuredClone(annotation.due);
      if (expected?.precision === 'instant' && expected.resolved !== null) expected.resolved = new Date(expected.resolved).toISOString();
      const actual = resolveDeadline(input, source);
      assert.deepEqual(actual.due, expected, `${fixture.id}/${annotation.id}: ${actual.reason ?? actual.status}`);
      assert.deepEqual([...deadlineUnknowns(annotation.unknown_fields, actual)].sort(), [...annotation.unknown_fields].sort(), `${annotation.id}: retained unknowns`);
    }
  }
});

test('D07 ambiguity and D14 missing interpretation context stay unresolved', () => {
  const fold = resolve('at 01:30 London time on 27 October 2030');
  assert.equal(fold.due.resolved, null); assert.equal(fold.due.precision, 'instant'); assert.equal(fold.due.zone, 'Europe/London');
  const literal = 'сегодня к 18:00 по Москве';
  for (const missing of [{ meeting_at: null }, { time_zone: null }]) {
    const result = resolve(literal, missing);
    assert.equal(result.due.resolved, null); assert.match(result.reason, /explicit meeting instant and IANA zone/);
  }
});
