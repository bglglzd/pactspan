import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../src/local/store.mjs';
import { Pactspan } from '../src/core/engine.mjs';
import { canonical } from '../src/core/data.mjs';

const moduleURL = new URL('../src/local/store.mjs', import.meta.url).href;
const AT = '2030-01-08T09:00:00Z';
const clock = () => AT;
const options = { clock };
const target = { adapter: 'demo', mode: 'synthetic', origin: 'demo://crm' };
const temporaryRoot = await fs.realpath(os.tmpdir());
const temp = () => fs.mkdtemp(path.join(temporaryRoot, 'pactspan-store-test-'));
const code = expected => error => { assert.equal(error.code, expected, error.message); return true; };
const exists = async filename => { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const hash = body => createHash('sha256').update(canonical(body), 'utf8').digest('hex');

test('domain and metadata retain separate node budgets inside a checksum-bound disk frame', async () => {
  const directory = await temp(); const store = await WorkspaceStore.open(directory, options);
  try {
    const domain = new Pactspan(undefined, options).snapshot();
    domain.events = Array.from({ length: 1900 }, (_, index) => ({ sequence: index + 1, at: AT, action: 'historical_fixture', target: 'fixture', detail: null }));
    const metadata = { rows: Array.from({ length: 3 }, () => Array.from({ length: 3300 }, () => 'metadata')) };
    await store.save({ domain, metadata });
    const loaded = await store.load(); assert.equal(loaded.domain.events.length, 1900); assert.equal(loaded.metadata.rows[2].length, 3300);
    assert.equal(JSON.parse(await store.raw()).checksum.length, 64);
  } finally { await store.close(); }
});

async function fixture() {
  const app = new Pactspan(undefined, options);
  const quote = 'Alex agrees to record USD 10800 on O1.';
  const source = (await app.importSource({ title: 'Synthetic store test', participants: [{ speaker: 'Alex', person_id: 'alex' }],
    segments: [{ speaker: 'Alex', start_secs: 0, end_secs: 4, text: quote }] })).source;
  const candidate = (await app.propose({ agreement: 'accepted', evidence: [{ source: source.id, segment: 0, quote }],
    terms: { kind: 'crm.amount', entity_id: 'O1', amount: '10800', currency: 'USD', owner: 'alex' } })).candidate;
  await app.confirm(candidate.id, { actor: 'manager', target });
  return { domain: app.snapshot(), metadata: { label: 'Original synthetic data' } };
}

const childScript = `
import fs from 'node:fs/promises';
import path from 'node:path';
const [directory, moduleURL, mode] = process.argv.slice(1);
const { WorkspaceStore } = await import(moduleURL);
const deadline = setTimeout(() => process.exit(98), 15000);
const realRename = fs.rename;
if (mode === 'pause-recovery') {
  let paused = false;
  fs.rename = async (from, to) => {
    if (!paused && path.basename(to).startsWith('.pactspan-stale-')) {
      paused = true; process.send({ paused: true });
      await new Promise(resolve => process.once('message', resolve));
    }
    return realRename(from, to);
  };
}
try {
  const store = await WorkspaceStore.open(directory);
  if (mode === 'leave') process.exit(0);
  if (mode === 'crash-before' || mode === 'crash-after') {
    const data = await store.load(); data.metadata.phase = 'new';
    fs.rename = async (from, to) => {
      if (path.basename(to) === 'state.json') {
        if (mode === 'crash-before') process.exit(31);
        await realRename(from, to); process.exit(32);
      }
      return realRename(from, to);
    };
    await store.save(data); process.exit(90);
  }
  process.send({ ready: true, pid: process.pid });
  await new Promise(resolve => process.once('message', resolve));
  await store.close(); clearTimeout(deadline); process.exit(0);
} catch(error) {
  process.send?.({ error: error.code, message: error.message });
  clearTimeout(deadline); process.exit(0);
}
`;

function child(directory, mode) {
  const processHandle = spawn(process.execPath, ['--input-type=module', '--eval', childScript, directory, moduleURL, mode],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const messages = [], waiters = [];
  let stderr = '';
  processHandle.stderr.on('data', chunk => { stderr += chunk; });
  processHandle.on('message', value => { if (waiters.length) waiters.shift()(value); else messages.push(value); });
  const done = new Promise((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('exit', (exitCode, signal) => {
      for (const waiter of waiters.splice(0)) waiter({ exitCode, signal, stderr });
      resolve({ exitCode, signal, stderr });
    });
  });
  return { process: processHandle, done, next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve)) };
}

test('disk revision, exact export, isolated snapshots and serialized saves survive reopening', async () => {
  const directory = await temp();
  const input = await fixture();
  const store = await WorkspaceStore.open(directory, options);
  try {
    assert.equal(await store.load(), null); assert.equal(await store.raw(), null);
    assert.equal(await store.save(input), 1);
    input.metadata.label = 'Caller mutation';
    const read = await store.load(); assert.equal(read.metadata.label, 'Original synthetic data');
    read.metadata.label = 'Returned-object mutation';
    assert.equal((await store.load()).metadata.label, 'Original synthetic data');
    const envelope = JSON.parse(await store.raw());
    assert.deepEqual(Object.keys(envelope).sort(), ['checksum', 'domain', 'metadata', 'revision', 'schema_version']);
    const { checksum, ...body } = envelope; assert.equal(checksum, hash(body));
    assert.equal(await store.raw(), await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
    const next = await fixture(); next.metadata.label = 'Second';
    const third = await fixture(); third.metadata.label = 'Third';
    assert.deepEqual(await Promise.all([store.save(next), store.save(third)]), [2, 3]);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, 'state.json'))).mode & 0o777, 0o600);
  } finally { await Promise.all([store.close(), store.close()]); }
  await assert.rejects(store.load(), code('WORKSPACE_CLOSED'));
  const reopened = await WorkspaceStore.open(directory, options);
  try { assert.equal((await reopened.load()).metadata.label, 'Third'); assert.equal(JSON.parse(await reopened.raw()).revision, 3); }
  finally { await reopened.close(); }
});

test('corrupt JSON/checksum/schema and hash-consistent altered domain fail closed while raw export retains bytes', async () => {
  const directory = await temp(); const store = await WorkspaceStore.open(directory, options);
  try {
    const valid = await fixture(); await store.save(valid);
    const original = await store.raw(); const baseline = JSON.parse(original);
    const changed = structuredClone(baseline); Object.values(changed.domain.versions)[0].terms.amount = '99999';
    const { checksum, ...changedBody } = changed; changed.checksum = hash(changedBody);
    const schema = { ...baseline, unexpected: true };
    for (const raw of ['{broken JSON\n', JSON.stringify({ ...baseline, checksum: '0'.repeat(64) }), JSON.stringify(schema), JSON.stringify(changed)]) {
      await fs.writeFile(path.join(directory, 'state.json'), raw);
      await assert.rejects(store.load(), code('WORKSPACE_CORRUPT'));
      await assert.rejects(store.save(valid), code('WORKSPACE_CORRUPT'));
      assert.equal(await store.raw(), raw);
      assert.equal(await fs.readFile(path.join(directory, 'state.json'), 'utf8'), raw);
    }
  } finally { await store.close(); }
});

test('invalid metadata/domain and total size are rejected without replacing a saved state', async () => {
  const directory = await temp(); const store = await WorkspaceStore.open(directory, options);
  try {
    const valid = await fixture(); await store.save(valid); const before = await store.raw();
    await assert.rejects(store.save({ ...valid, metadata: { value: Infinity } }), code('WORKSPACE_INPUT'));
    await assert.rejects(store.save({ ...valid, metadata: JSON.parse('{"__proto__":{}}') }), code('WORKSPACE_INPUT'));
    await assert.rejects(store.save({ ...valid, metadata: { value: new Array(1) } }), code('WORKSPACE_INPUT'));
    const forged = structuredClone(valid); Object.values(forged.domain.versions)[0].terms.amount = '99999';
    await assert.rejects(store.save(forged), code('WORKSPACE_INPUT'));
    const large = { ...valid, metadata: Array.from({ length: 9 }, () => 'x'.repeat(262144)) };
    await assert.rejects(store.save(large), code('WORKSPACE_TOO_LARGE'));
    assert.equal(await store.raw(), before);
  } finally { await store.close(); }
});

test('active owner excludes another store in the same PID and another process', async () => {
  const directory = await temp(); const store = await WorkspaceStore.open(directory, options);
  try {
    await assert.rejects(WorkspaceStore.open(directory), code('WORKSPACE_LOCKED'));
    const contender = child(directory, 'hold');
    assert.equal((await contender.next()).error, 'WORKSPACE_LOCKED');
    assert.equal((await contender.done).exitCode, 0);
  } finally { await store.close(); }
  const holder = child(directory, 'hold');
  const ready = await holder.next(); assert.equal(ready.ready, true);
  try { await assert.rejects(WorkspaceStore.open(directory), code('WORKSPACE_LOCKED')); }
  finally { holder.process.send('close'); assert.equal((await holder.done).exitCode, 0); }
});

test('crashes immediately before and after atomic state rename leave valid old/new state and preserve dead-owner tombstones', async () => {
  for (const mode of ['crash-before', 'crash-after']) {
    const directory = await temp(); const initial = await WorkspaceStore.open(directory, options);
    const input = await fixture(); input.metadata.phase = 'old'; await initial.save(input); await initial.close();
    const crashed = child(directory, mode); const outcome = await crashed.done;
    assert.equal(outcome.exitCode, mode === 'crash-before' ? 31 : 32, outcome.stderr);
    const restored = await WorkspaceStore.open(directory, options);
    try {
      assert.equal((await restored.load()).metadata.phase, mode === 'crash-before' ? 'old' : 'new');
      assert.equal(JSON.parse(await restored.raw()).revision, mode === 'crash-before' ? 1 : 2);
      const tombstones = (await fs.readdir(directory)).filter(name => name.startsWith('.pactspan-stale-'));
      assert.equal(tombstones.length, 1);
      const owner = JSON.parse(await fs.readFile(path.join(directory, tombstones[0], 'owner.json'), 'utf8'));
      assert.equal(owner.pid, crashed.process.pid);
    } finally { await restored.close(); }
  }
});

test('a paused stale observer cannot rename the newer live owner after another process recovers', async () => {
  const directory = await temp(); const abandoned = child(directory, 'leave');
  assert.equal((await abandoned.done).exitCode, 0);
  const paused = child(directory, 'pause-recovery');
  assert.equal((await paused.next()).paused, true);
  const winner = child(directory, 'hold');
  assert.equal((await winner.next()).ready, true);
  try {
    paused.process.send('continue');
    assert.equal((await paused.next()).error, 'WORKSPACE_LOCKED');
    assert.equal((await paused.done).exitCode, 0);
    const current = JSON.parse(await fs.readFile(path.join(directory, '.pactspan-lock', 'owner.json'), 'utf8'));
    assert.equal(current.pid, winner.process.pid);
    const tombstones = (await fs.readdir(directory)).filter(name => name.startsWith('.pactspan-stale-'));
    assert.equal(tombstones.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, tombstones[0], 'owner.json'), 'utf8')).pid, abandoned.process.pid);
  } finally { winner.process.send('close'); assert.equal((await winner.done).exitCode, 0); }
});

test('close refuses an owner changed by another actor and never deletes that lock', async () => {
  const directory = await temp(); const store = await WorkspaceStore.open(directory, options);
  const filename = path.join(directory, '.pactspan-lock', 'owner.json');
  const changed = JSON.parse(await fs.readFile(filename, 'utf8')); changed.nonce = randomUUID();
  await fs.writeFile(filename, JSON.stringify(changed));
  await assert.rejects(store.save(await fixture()), code('WORKSPACE_LOCK_LOST'));
  await assert.rejects(store.close(), code('WORKSPACE_LOCK_LOST'));
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), changed);
});

test('symlink/junction workspace roots and incomplete lock owners are preserved and rejected', async () => {
  const directory = await temp(); const targetDirectory = await temp(); const link = path.join(directory, 'alias');
  await fs.symlink(targetDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(WorkspaceStore.open(link), code('WORKSPACE_UNSAFE_PATH'));
  assert.equal(await exists(path.join(targetDirectory, '.pactspan-lock')), false);
  const invalid = await temp(); await fs.mkdir(path.join(invalid, '.pactspan-lock'));
  await assert.rejects(WorkspaceStore.open(invalid), code('WORKSPACE_LOCK_INVALID'));
  assert.equal(await exists(path.join(invalid, '.pactspan-lock')), true);
});

test('a state-file symlink cannot import or overwrite a file outside the workspace', async t => {
  const directory = await temp(); const externalDirectory = await temp(); const outside = path.join(externalDirectory, 'outside.json');
  await fs.writeFile(outside, 'outside sentinel');
  try { await fs.symlink(outside, path.join(directory, 'state.json'), 'file'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows account lacks file-symlink permission; junction root rejection is checked separately'); return; } throw error; }
  const store = await WorkspaceStore.open(directory, options);
  try {
    await assert.rejects(store.load(), code('WORKSPACE_UNSAFE_PATH'));
    await assert.rejects(store.save(await fixture()), code('WORKSPACE_UNSAFE_PATH'));
    assert.equal(await fs.readFile(outside, 'utf8'), 'outside sentinel');
  } finally { await store.close(); }
});
