import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pactspan } from '../core/engine.mjs';
import { canonical, fields, jsonData } from '../core/data.mjs';

const LIMIT = 2 * 1024 * 1024;
const LOCK = '.pactspan-lock';
const OWNER = 'owner.json';
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OPENED = Symbol('locked workspace');

export class WorkspaceStoreError extends Error {
  constructor(code, message, options) {
    super(message, options); this.name = 'WorkspaceStoreError'; this.code = code;
  }
}

function fail(code, message) { throw new WorkspaceStoreError(code, message); }
function identity(stat) { return `${stat.dev}:${stat.ino}`; }
function samePath(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function digest(value) { return createHash('sha256').update(canonical(value), 'utf8').digest('hex'); }
function wrapped(error, code, message) {
  return error instanceof WorkspaceStoreError ? error : new WorkspaceStoreError(code, message, { cause: error });
}

async function statOrNull(filename) {
  try { return await fs.lstat(filename, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function directoryTree(directory, create = false) {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of ['', ...directory.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat = await statOrNull(current);
    if (!stat && create) {
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await statOrNull(current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail('WORKSPACE_UNSAFE_PATH', 'Workspace directories must exist without symbolic links or junctions');
  }
  return { directory: await fs.realpath(directory), stat: await fs.lstat(directory, { bigint: true }) };
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, constants.O_RDONLY); await handle.sync(); }
  catch (error) {
    // Node/Windows does not provide a directory fsync. File fsync and atomic rename
    // still apply; sudden power-loss durability of the directory entry is not claimed.
    if (!(process.platform === 'win32' && ['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code))) throw error;
  } finally { await handle?.close(); }
}

async function readRegular(filename, maximum, unsafeCode = 'WORKSPACE_UNSAFE_PATH') {
  const before = await statOrNull(filename);
  if (!before) return null;
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) fail(unsafeCode, 'Workspace files must be regular files with a single link');
  if (before.size > BigInt(maximum)) fail('WORKSPACE_CORRUPT', 'Saved workspace exceeds its size limit');
  const handle = await fs.open(filename, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || identity(opened) !== identity(before) || opened.nlink !== 1n) fail(unsafeCode, 'Workspace file changed while opening it');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) fail('WORKSPACE_CORRUPT', 'Saved workspace exceeds its size limit');
    const after = await handle.stat({ bigint: true });
    const named = await statOrNull(filename);
    if (!named || named.isSymbolicLink() || identity(named) !== identity(before)
      || identity(after) !== identity(before) || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
      fail(unsafeCode, 'Workspace file changed while reading it');
    }
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
    catch { fail('WORKSPACE_CORRUPT', 'Saved workspace is not valid UTF-8'); }
  } finally { await handle.close(); }
}

async function ownerAt(directory) {
  const stat = await statOrNull(directory);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail('WORKSPACE_LOCK_INVALID', 'Workspace lock is missing or is not a safe directory');
  let owner;
  try {
    const raw = await readRegular(path.join(directory, OWNER), 4096, 'WORKSPACE_LOCK_INVALID');
    if (raw === null) throw new Error('missing owner');
    owner = JSON.parse(raw);
    fields(owner, ['schema_version', 'pid', 'nonce', 'created_at'], 'lock owner');
    if (owner.schema_version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1
      || typeof owner.nonce !== 'string' || !UUID.test(owner.nonce)
      || typeof owner.created_at !== 'string' || !Number.isFinite(Date.parse(owner.created_at))) throw new Error('invalid owner');
  } catch (error) { throw wrapped(error, 'WORKSPACE_LOCK_INVALID', 'Workspace lock owner is missing or invalid; preserve it for inspection'); }
  return { owner, identity: identity(stat) };
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    fail('WORKSPACE_LOCK_INVALID', 'The workspace lock process could not be checked safely');
  }
}

async function removeOwnedDirectory(directory, owner, expectedIdentity) {
  const found = await ownerAt(directory);
  if (found.identity !== expectedIdentity || canonical(found.owner) !== canonical(owner)) fail('WORKSPACE_LOCK_LOST', 'Workspace lock ownership changed; nothing was removed');
  await fs.unlink(path.join(directory, OWNER));
  // Never recursively remove a lock: unexpected contents must survive inspection.
  await fs.rmdir(directory);
}

async function acquire(directory) {
  const owner = { schema_version: 1, pid: process.pid, nonce: randomUUID(), created_at: new Date().toISOString() };
  const pending = path.join(directory, `.pactspan-lock-pending-${owner.nonce}`);
  const locked = path.join(directory, LOCK);
  await fs.mkdir(pending, { mode: 0o700 });
  const pendingIdentity = identity(await fs.lstat(pending, { bigint: true }));
  const handle = await fs.open(path.join(pending, OWNER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(owner) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(pending);
  let installed = false;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!(await statOrNull(locked))) {
        try {
          // Cooperating contenders always install a nonempty directory. Inspect
          // an existing path first: POSIX rename can replace an empty directory.
          await fs.rename(pending, locked); installed = true;
          await syncDirectory(directory);
          return { owner, identity: pendingIdentity };
        } catch (error) {
          if (installed || !(await statOrNull(locked))) throw error;
        }
      }
      const found = await ownerAt(locked);
      if (processIsAlive(found.owner.pid)) fail('WORKSPACE_LOCKED', 'Workspace is locked by an active process, including another store in this process');
      const checked = await ownerAt(locked);
      if (checked.identity !== found.identity || canonical(checked.owner) !== canonical(found.owner)) continue;
      if (processIsAlive(checked.owner.pid)) fail('WORKSPACE_LOCKED', 'Workspace lock process became active');
      const tombstone = path.join(directory, `.pactspan-stale-${checked.owner.nonce}`);
      if (await statOrNull(tombstone)) fail('WORKSPACE_LOCK_CONFLICT', 'A stale-lock tombstone already exists; nothing was replaced');
      try {
        // The deterministic, nonempty destination stops a second stale observer
        // from later renaming a newer live lock into the same tombstone.
        await fs.rename(locked, tombstone);
      } catch (error) {
        if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) continue;
        throw error;
      }
      const preserved = await ownerAt(tombstone);
      if (preserved.identity !== checked.identity || canonical(preserved.owner) !== canonical(checked.owner)) fail('WORKSPACE_LOCK_CONFLICT', 'Stale lock changed during recovery; preserved directory requires inspection');
      await syncDirectory(directory);
    }
    fail('WORKSPACE_LOCKED', 'Workspace lock changed during acquisition; try again');
  } finally {
    if (!installed && await statOrNull(pending)) await removeOwnedDirectory(pending, owner, pendingIdentity);
  }
}

function cloneInput(value) {
  try {
    fields(value, ['domain', 'metadata'], 'workspace save');
    if (!Object.hasOwn(value, 'domain') || !Object.hasOwn(value, 'metadata')) throw new Error('missing data');
    jsonData(value);
    const pending = [value];
    let bytes = 0;
    while (pending.length) {
      const item = pending.pop();
      if (Array.isArray(item)) {
        bytes += 2 + Math.max(0, item.length - 1);
        for (const child of item) pending.push(child);
      } else if (item !== null && typeof item === 'object') {
        const entries = Object.entries(item);
        bytes += 2 + Math.max(0, entries.length - 1);
        for (const [key, child] of entries) { bytes += Buffer.byteLength(JSON.stringify(key)) + 1; pending.push(child); }
      } else {
        if (item === undefined) throw new Error('sparse array');
        bytes += Buffer.byteLength(JSON.stringify(item));
      }
      if (bytes > LIMIT) fail('WORKSPACE_TOO_LARGE', 'Workspace exceeds 2 MiB');
    }
    const copy = structuredClone(value);
    // Round-trip once before validation/hashing so no caller-owned references survive.
    return JSON.parse(JSON.stringify(copy));
  } catch (error) { throw wrapped(error, 'WORKSPACE_INPUT', 'Workspace save requires JSON domain and metadata'); }
}

export class WorkspaceStore {
  #directory; #rootIdentity; #owner; #lockIdentity; #clock; #tail = Promise.resolve(); #closing = false; #closed = false; #closePromise;

  constructor(token, root, lock, clock) {
    if (token !== OPENED) fail('WORKSPACE_INPUT', 'Use await WorkspaceStore.open(directory)');
    this.#directory = root.directory; this.#rootIdentity = identity(root.stat);
    this.#owner = lock.owner; this.#lockIdentity = lock.identity; this.#clock = clock;
  }

  static async open(directory, { clock } = {}) {
    if (typeof directory !== 'string' || !directory.length || directory.includes('\0') || (clock !== undefined && typeof clock !== 'function')) fail('WORKSPACE_INPUT', 'Workspace directory and optional clock are invalid');
    try {
      const root = await directoryTree(path.resolve(directory), true);
      const lock = await acquire(root.directory);
      return new WorkspaceStore(OPENED, root, lock, clock);
    } catch (error) { throw wrapped(error, 'WORKSPACE_IO', 'Workspace could not be opened'); }
  }

  async #assertOwned() {
    const root = await directoryTree(this.#directory);
    if (!samePath(root.directory, this.#directory) || identity(root.stat) !== this.#rootIdentity) fail('WORKSPACE_UNSAFE_PATH', 'Workspace root changed; no file was written');
    const lock = await ownerAt(path.join(this.#directory, LOCK));
    if (lock.identity !== this.#lockIdentity || canonical(lock.owner) !== canonical(this.#owner)) fail('WORKSPACE_LOCK_LOST', 'Workspace lock ownership changed; no file was written');
  }

  #enqueue(action) {
    if (this.#closing || this.#closed) return Promise.reject(new WorkspaceStoreError('WORKSPACE_CLOSED', 'Workspace store is closed'));
    const pending = this.#tail.then(async () => {
      await this.#assertOwned();
      try { return await action(); }
      catch (error) { throw wrapped(error, 'WORKSPACE_IO', 'Workspace operation failed'); }
    });
    this.#tail = pending.catch(() => {});
    return pending;
  }

  async #raw() { return readRegular(path.join(this.#directory, 'state.json'), LIMIT); }

  async #validated() {
    const raw = await this.#raw();
    if (raw === null) return null;
    try {
      const envelope = JSON.parse(raw);
      jsonData(envelope); fields(envelope, ['schema_version', 'revision', 'domain', 'metadata', 'checksum'], 'saved workspace');
      if (envelope.schema_version !== 1 || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1
        || typeof envelope.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.checksum)) throw new Error('invalid envelope');
      const body = Object.fromEntries(['schema_version', 'revision', 'domain', 'metadata'].map(key => [key, envelope[key]]));
      if (digest(body) !== envelope.checksum) throw new Error('checksum mismatch');
      await Pactspan.restore(envelope.domain, this.#clock ? { clock: this.#clock } : {});
      return envelope;
    } catch (error) { throw wrapped(error, 'WORKSPACE_CORRUPT', 'Saved workspace failed schema, checksum or domain integrity validation; original file was retained'); }
  }

  load() { return this.#enqueue(async () => { const value = await this.#validated(); return value === null ? null : structuredClone({ domain: value.domain, metadata: value.metadata }); }); }
  raw() { return this.#enqueue(() => this.#raw()); }

  save(value) {
    let input;
    try { input = cloneInput(value); }
    catch (error) { return Promise.reject(error); }
    return this.#enqueue(async () => {
      try { await Pactspan.restore(input.domain, this.#clock ? { clock: this.#clock } : {}); jsonData(input.metadata); }
      catch (error) { throw wrapped(error, 'WORKSPACE_INPUT', 'Workspace domain or metadata is invalid'); }
      const previous = await this.#validated();
      const revision = (previous?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) fail('WORKSPACE_CORRUPT', 'Workspace revision cannot be incremented safely');
      const body = { schema_version: 1, revision, ...input };
      const encoded = canonical({ ...body, checksum: digest(body) }) + '\n';
      if (Buffer.byteLength(encoded, 'utf8') > LIMIT) fail('WORKSPACE_TOO_LARGE', 'Workspace exceeds 2 MiB');
      await this.#assertOwned();
      const temporary = path.join(this.#directory, `.state-${this.#owner.nonce}-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      let temporaryIdentity;
      try {
        temporaryIdentity = identity(await handle.stat({ bigint: true }));
        await handle.writeFile(encoded, 'utf8'); await handle.sync();
      } finally { await handle.close(); }
      try {
        await this.#assertOwned();
        const current = await this.#raw();
        if (current !== (previous === null ? null : canonical(previous) + '\n')) {
          // Existing valid files need not use our whitespace, so compare the
          // validated content as well as absence before replacing anything.
          const latest = await this.#validated();
          if (canonical(latest) !== canonical(previous)) fail('WORKSPACE_CORRUPT', 'Workspace changed before commit; original was retained');
        }
        await fs.rename(temporary, path.join(this.#directory, 'state.json'));
        await syncDirectory(this.#directory);
      } finally {
        const leftover = await statOrNull(temporary);
        if (leftover && !leftover.isSymbolicLink() && leftover.isFile() && identity(leftover) === temporaryIdentity) await fs.unlink(temporary);
      }
      return revision;
    });
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return Promise.resolve();
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#tail;
      try {
        await this.#assertOwned();
        const released = path.join(this.#directory, `.pactspan-closed-${this.#owner.nonce}`);
        if (await statOrNull(released)) fail('WORKSPACE_LOCK_CONFLICT', 'A lock release path already exists; nothing was replaced');
        await fs.rename(path.join(this.#directory, LOCK), released);
        await removeOwnedDirectory(released, this.#owner, this.#lockIdentity);
        await syncDirectory(this.#directory);
      } catch (error) { throw wrapped(error, 'WORKSPACE_IO', 'Workspace lock could not be released safely'); }
      finally { this.#closed = true; }
    })();
    return this.#closePromise;
  }
}
