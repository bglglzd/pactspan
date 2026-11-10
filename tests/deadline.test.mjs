import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeadline, deadlineUnknowns } from '../src/adapters/deadline.mjs';
import { instant } from '../src/core/data.mjs';

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
