import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('the installed POSIX-style bin symlink executes the same CLI as a direct Node path', async t => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const execute = promisify(execFile);
  const direct = await execute(process.execPath, [cli, 'help']);
  assert.match(direct.stdout, /pactspan serve/); assert.match(direct.stdout, /pactspan export/);
  const folder = await mkdtemp(path.join(os.tmpdir(), 'pactspan-bin-')); const bin = path.join(folder, 'pactspan');
  try { await symlink(cli, bin, 'file'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip('Windows account lacks file-symlink permission; direct entry passed, POSIX bin checked on Linux'); return; } throw error; }
  const linked = await execute(process.execPath, [bin, 'help']);
  assert.equal(linked.stdout, direct.stdout); assert.equal(linked.stderr, '');
});
