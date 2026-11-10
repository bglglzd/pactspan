import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { requireValue } from '../core/data.mjs';

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  requireValue(!(await lstat(directory)).isSymbolicLink(), 'Local data directory must not be a symbolic link');
  return realpath(directory);
}

function filePath(root, name) {
  requireValue(/^[a-zA-Z0-9_.-]+\.json$/.test(name), 'Invalid local data filename');
  return path.join(root, name);
}

export async function privateRead(root, name, maximum = 2 * 1024 * 1024) {
  const filename = filePath(root, name);
  let stats;
  try { stats = await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  requireValue(stats.isFile() && !stats.isSymbolicLink() && stats.size <= maximum, 'Invalid or oversized local data file');
  const handle = await open(filename, 'r');
  try {
    const bytes = await handle.readFile();
    requireValue(bytes.length <= maximum, 'Local data file exceeds its limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { await handle.close(); }
}

export async function privateWrite(root, name, value, { exclusive = false } = {}) {
  const destination = filePath(root, name);
  // Existing links or special files never become application-owned output.
  try { const info = await lstat(destination); requireValue(info.isFile() && !info.isSymbolicLink() && !exclusive, 'Local output already exists or is not a regular file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  requireValue(bytes.length <= 2 * 1024 * 1024, 'Local output exceeds 2 MiB');
  const temporary = filePath(root, `.pending-${randomUUID()}.json`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, destination);
    // Directory fsync is supported on Unix; Windows does not expose it here.
    if (process.platform !== 'win32') { const directory = await open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return createHash('sha256').update(bytes).digest('hex');
}
