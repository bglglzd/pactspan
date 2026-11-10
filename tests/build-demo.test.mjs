import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm, realpath, lstat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildDemo } from '../scripts/build-demo.mjs';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const manifestName = 'pactspan-demo-output.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pactspan-demo-test-'));
  const canonical = await realpath(temporary);
  t.after(async () => {
    // Every fixture and synthetic "secret" was authored by this test, outside user/repository state.
    assert.equal(await realpath(temporary), canonical);
    assert.ok(path.basename(canonical).startsWith('pactspan-demo-test-'));
    await rm(canonical, { recursive: true, force: true });
  });
  return { temporary: canonical, out: path.join(canonical, 'artifact') };
}

async function bytes(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, manifestName), 'utf8'));
  const values = {};
  for (const name of [...manifest.files.map(item => item.path), manifestName]) values[name] = digest(await readFile(path.join(directory, name)));
  return values;
}

test('fresh/repeated builds contain only deterministic public allowlist files and public manifest data', async t => {
  const { out, temporary } = await fixture(t);
  assert.equal(await buildDemo({ out }), out);
  const first = await bytes(out);
  const manifest = JSON.parse(await readFile(path.join(out, manifestName), 'utf8'));
  const optionalLocal = await lstat(path.join(root, 'public/local.mjs')).then(() => true, () => false);
  assert.deepEqual(manifest.files.map(file => file.path).sort(), [
    'adapters/demo.mjs', 'app.mjs', 'core/data.mjs', 'core/engine.mjs', 'core/money.mjs', 'core/source.mjs',
    'core/terms.mjs', 'data/development.mjs', 'index.html', 'mark.svg', 'styles.css', ...(optionalLocal ? ['local.mjs'] : []),
  ].sort());
  assert.ok(!JSON.stringify(manifest).includes(root) && !JSON.stringify(manifest).includes(temporary));
  assert.ok(!manifest.files.some(file => /espo|extract|src\/local|\.env|credential|portfolio|holdout/.test(file.path)));
  for (const file of manifest.files) {
    const value = await readFile(path.join(out, file.path));
    assert.equal(file.bytes, value.length); assert.equal(file.sha256, digest(value));
  }
  await buildDemo({ out });
  assert.deepEqual(await bytes(out), first);
  assert.deepEqual(await readdir(temporary), ['artifact']);
  assert.match(await readFile(path.join(out, 'data/development.mjs'), 'utf8'), /Authored synthetic cases, not model extraction output/);
});

test('an untracked secret in managed output is refused untouched; a fresh output remains clean', async t => {
  const { out, temporary } = await fixture(t);
  await buildDemo({ out });
  const secret = path.join(out, 'api-credentials.json');
  await writeFile(secret, 'SYNTHETIC SECRET FIXTURE ONLY');
  await assert.rejects(buildDemo({ out }), /unknown or stale.*fresh --out/);
  assert.equal(await readFile(secret, 'utf8'), 'SYNTHETIC SECRET FIXTURE ONLY');
  const fresh = path.join(temporary, 'fresh');
  await buildDemo({ out: fresh });
  await assert.rejects(readFile(path.join(fresh, 'api-credentials.json')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(temporary), ['artifact', 'fresh']);
});

test('an unmanaged existing directory is never adopted, moved or recursively removed', async t => {
  const { out, temporary } = await fixture(t);
  await mkdir(out); await writeFile(path.join(out, 'index.html'), 'Caller-owned old output');
  await writeFile(path.join(out, '.env'), 'SYNTHETIC SECRET FIXTURE ONLY');
  await assert.rejects(buildDemo({ out }), /ownership manifest.*fresh --out/);
  assert.equal(await readFile(path.join(out, 'index.html'), 'utf8'), 'Caller-owned old output');
  assert.equal(await readFile(path.join(out, '.env'), 'utf8'), 'SYNTHETIC SECRET FIXTURE ONLY');
  assert.deepEqual(await readdir(temporary), ['artifact']);
});

test('verified older owned bytes are safely replaced and a stale optional asset cannot survive', async t => {
  const { out, temporary } = await fixture(t);
  await buildDemo({ out });
  const marker = path.join(out, manifestName); const manifest = JSON.parse(await readFile(marker, 'utf8'));
  // Model a prior owned build that had another version of the explicitly allowed optional asset.
  const old = Buffer.from('// Synthetic prior managed public asset\n');
  await writeFile(path.join(out, 'local.mjs'), old);
  const index = manifest.files.findIndex(file => file.path === 'local.mjs');
  const entry = { path: 'local.mjs', bytes: old.length, sha256: digest(old) };
  if (index < 0) manifest.files.push(entry); else manifest.files[index] = entry;
  await writeFile(marker, JSON.stringify(manifest, null, 2) + '\n');
  await buildDemo({ out });
  const current = await readFile(path.join(root, 'public/local.mjs')).catch(() => null);
  if (current === null) await assert.rejects(readFile(path.join(out, 'local.mjs')), { code: 'ENOENT' });
  else assert.deepEqual(await readFile(path.join(out, 'local.mjs')), current);
  assert.deepEqual(await readdir(temporary), ['artifact']);
});

test('manually changed files and forged manifest traversal are refused without touching caller data', async t => {
  const { out, temporary } = await fixture(t); await buildDemo({ out });
  await writeFile(path.join(out, 'index.html'), 'SYNTHETIC MANUAL EDIT');
  await assert.rejects(buildDemo({ out }), /modified.*fresh --out/);
  assert.equal(await readFile(path.join(out, 'index.html'), 'utf8'), 'SYNTHETIC MANUAL EDIT');
  const second = path.join(temporary, 'second'); await buildDemo({ out: second });
  const marker = path.join(second, manifestName), manifest = JSON.parse(await readFile(marker, 'utf8'));
  const outside = path.join(temporary, 'outside.txt'); await writeFile(outside, 'SYNTHETIC CALLER FILE');
  manifest.files[0].path = '../outside.txt'; await writeFile(marker, JSON.stringify(manifest));
  await assert.rejects(buildDemo({ out: second }), /unknown output paths/);
  assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC CALLER FILE');
});

test('source/repository/ancestor and link output boundaries are rejected', async t => {
  const { temporary } = await fixture(t);
  await assert.rejects(buildDemo({ out: path.join(temporary, 'artifact.') }), /canonical directory name/);
  for (const out of [root, path.dirname(root), path.join(root, 'public/not-an-output'), path.join(root, 'src/not-an-output'),
    path.join(root, 'scripts/not-an-output'), path.join(root, '.git/not-an-output')]) {
    await assert.rejects(buildDemo({ out }), /source\/control|repository|directory name/);
  }
  const outside = path.join(temporary, 'caller'); await mkdir(outside); await writeFile(path.join(outside, 'secret.txt'), 'SYNTHETIC CALLER FILE');
  const link = path.join(temporary, 'link');
  try { await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Host cannot create test symlink; path rejection above still checked'); return; } throw error; }
  await assert.rejects(buildDemo({ out: link }), /link|real directory/);
  await assert.rejects(buildDemo({ out: path.join(link, 'child') }), /symbolic links|junctions/);
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'SYNTHETIC CALLER FILE');
});

test('a nested output link and unknown empty directory cannot enter a repeated artifact', async t => {
  const { out, temporary } = await fixture(t); await buildDemo({ out });
  await mkdir(path.join(out, 'unexpected'));
  await assert.rejects(buildDemo({ out }), /unknown or stale/);
  const second = path.join(temporary, 'second'); await buildDemo({ out: second });
  try { await symlink(path.join(temporary, 'artifact'), path.join(second, 'credentials'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Host cannot create nested test symlink'); return; } throw error; }
  await assert.rejects(buildDemo({ out: second }), /unknown or stale|links/);
});

test('existing unknown locks are preserved and concurrent builds never combine their output', async t => {
  const { out, temporary } = await fixture(t);
  const lock = path.join(temporary, '.artifact.pactspan-demo.lock'); await writeFile(lock, 'CALLER LOCK');
  await assert.rejects(buildDemo({ out }), /lock exists/);
  assert.equal(await readFile(lock, 'utf8'), 'CALLER LOCK'); await rm(lock);
  const outcomes = await Promise.allSettled([buildDemo({ out }), buildDemo({ out })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  await buildDemo({ out }); assert.deepEqual(await readdir(temporary), ['artifact']);
});

test('CLI supports an explicit fresh --out without changing source or copying control files', async t => {
  const { out } = await fixture(t);
  const run = promisify(execFile);
  const result = await run(process.execPath, [path.join(root, 'scripts/build-demo.mjs'), '--out', out], { cwd: os.tmpdir() });
  assert.equal(result.stdout.trim(), out); assert.equal(result.stderr, '');
  assert.ok((await bytes(out))['index.html']);
  await assert.rejects(run(process.execPath, [path.join(root, 'scripts/build-demo.mjs'), '--unknown', out]), /Usage:/);
});

test('a fixed synthetic source tree copies optional local.mjs but excludes untracked assets, server keys and extra cases', async t => {
  const { temporary } = await fixture(t);
  const repository = path.join(temporary, 'fixture-source');
  const content = {};
  for (const name of ['index.html', 'app.mjs', 'mark.svg', 'styles.css', 'local.mjs']) content['public/' + name] = 'PUBLIC FIXTURE ' + name;
  for (const name of ['data', 'engine', 'money', 'source', 'terms']) content['src/core/' + name + '.mjs'] = '// PUBLIC CORE FIXTURE';
  content['src/adapters/demo.mjs'] = '// PUBLIC DEMO FIXTURE';
  content['scripts/build-demo.mjs'] = await readFile(path.join(root, 'scripts/build-demo.mjs'), 'utf8');
  for (let number = 1; number <= 20; number++) content[`examples/development/D${String(number).padStart(2, '0')}.json`] = JSON.stringify({ synthetic_id: number });
  for (const name of ['public/credentials.env', 'public/nested/private.json', 'src/adapters/espo.mjs', 'src/local/keys.json',
    'control/portfolio.json', 'examples/development/D21.json']) content[name] = '{"DO_NOT_PUBLISH":"SYNTHETIC_CONTROL_MARKER"}';
  for (const [relative, value] of Object.entries(content)) {
    const filename = path.join(repository, relative); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, value);
  }
  const run = promisify(execFile);
  const result = await run(process.execPath, [path.join(repository, 'scripts/build-demo.mjs')], { cwd: temporary });
  const out = result.stdout.trim();
  assert.equal(out, path.join(repository, 'dist'));
  const manifest = JSON.parse(await readFile(path.join(out, manifestName), 'utf8'));
  assert.ok(manifest.files.some(file => file.path === 'local.mjs'));
  assert.equal(await readFile(path.join(out, 'local.mjs'), 'utf8'), 'PUBLIC FIXTURE local.mjs');
  for (const item of manifest.files) assert.ok(!(await readFile(path.join(out, item.path), 'utf8')).includes('SYNTHETIC_CONTROL_MARKER'));
  assert.deepEqual((await import(pathToFileURL(path.join(out, 'data/development.mjs')).href)).CASES.map(item => item.synthetic_id), Array.from({ length: 20 }, (_, index) => index + 1));
});
