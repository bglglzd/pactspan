import { mkdir, readFile, readdir, writeFile, lstat, realpath, mkdtemp, rename, unlink, rmdir, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const MANIFEST = 'pactspan-demo-output.json';
const FORMAT = 'pactspan-demo-output-v1';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const sources = [
  ['index.html', 'public/index.html'], ['app.mjs', 'public/app.mjs'], ['mark.svg', 'public/mark.svg'],
  ['styles.css', 'public/styles.css'], ...['data', 'engine', 'money', 'source', 'terms'].map(name => [`core/${name}.mjs`, `src/core/${name}.mjs`]),
  ['adapters/demo.mjs', 'src/adapters/demo.mjs'],
];
const optional = ['local.mjs', 'public/local.mjs'];
const mandatory = [...sources.map(([name]) => name), 'data/development.mjs'];
const allowed = new Set([...mandatory, optional[0]]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (base, target) => { const relative = path.relative(base, target); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };

async function stat(name) {
  try { return await lstat(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function noLinks(name) {
  let current = path.parse(name).root;
  for (const component of path.relative(current, name).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Build paths must not contain symbolic links or junctions');
  }
}

async function outputPath(out) {
  if (typeof out !== 'string' || !out || out.includes('\0')) throw new Error('Use a nonempty --out path');
  const requested = path.resolve(root, out);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(path.basename(requested)) || path.basename(requested).endsWith('.')) throw new Error('Output requires a plain canonical directory name');
  const protectedPath = value => within(value, root) || ['public', 'src', 'scripts', 'examples', 'tests', '.git', '.pactspan', 'node_modules']
    .some(directory => within(path.join(root, directory), value));
  if (protectedPath(requested)) throw new Error('Output must not replace the repository, its ancestors or source/control directories');
  await noLinks(path.dirname(requested));
  const result = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  if (protectedPath(result)) throw new Error('Output must not replace the repository, its ancestors or source/control directories');
  const info = await stat(result);
  if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('Output must be a real directory, never a link or file');
  return info ? realpath(result) : result;
}

async function sourceBytes(relative, optionalFile = false) {
  const filename = path.join(root, relative);
  if (optionalFile && !(await stat(filename))) return null;
  await noLinks(filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Source must be a bounded regular allowlisted file: ' + relative);
  return readFile(filename);
}

function directories(files) {
  return [...new Set(files.flatMap(name => {
    const result = []; let parent = path.posix.dirname(name);
    while (parent !== '.') { result.push(parent); parent = path.posix.dirname(parent); }
    return result;
  }))].sort();
}

async function inventory(directory, permittedFiles, permittedDirs, prefix = '') {
  const files = [], dirs = [];
  for (const name of (await readdir(path.join(directory, prefix))).sort()) {
    const relative = prefix ? prefix + '/' + name : name;
    if (!permittedFiles.has(relative) && !permittedDirs.has(relative)) throw new Error('Output contains unknown or stale entries; choose a fresh --out');
    const info = await lstat(path.join(directory, relative));
    if (info.isSymbolicLink()) throw new Error('Output links are not owned build files; choose a fresh --out');
    if (info.isDirectory()) {
      dirs.push(relative); const child = await inventory(directory, permittedFiles, permittedDirs, relative); files.push(...child.files); dirs.push(...child.dirs);
    } else if (info.isFile()) files.push(relative);
    else throw new Error('Output contains an unsupported file type; choose a fresh --out');
  }
  return { files: files.sort(), dirs: dirs.sort() };
}

async function owned(directory) {
  const info = await stat(directory);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error('Managed output is not a real directory');
  const manifestPath = path.join(directory, MANIFEST), marker = await stat(manifestPath);
  if (!marker || marker.isSymbolicLink() || !marker.isFile() || marker.size > 16384) throw new Error('Output has no recognized ownership manifest; choose a fresh --out');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new Error('Invalid output ownership manifest; choose a fresh --out'); }
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'files,format' || manifest.format !== FORMAT || !Array.isArray(manifest.files)
      || manifest.files.length < mandatory.length || manifest.files.length > allowed.size) throw new Error('Unrecognized output ownership; choose a fresh --out');
  const names = manifest.files.map(file => file?.path);
  if (new Set(names).size !== names.length || !mandatory.every(name => names.includes(name))
      || manifest.files.some(file => !file || typeof file !== 'object' || Array.isArray(file) || !allowed.has(file.path) || Object.keys(file).sort().join(',') !== 'bytes,path,sha256'
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256))) {
    throw new Error('Manifest contains unknown output paths; choose a fresh --out');
  }
  const actual = await inventory(directory, new Set([...names, MANIFEST]), new Set(directories(names)));
  if (actual.files.join('\n') !== [...names, MANIFEST].sort().join('\n') || actual.dirs.join('\n') !== directories(names).join('\n')) {
    throw new Error('Output contains unknown or stale entries; choose a fresh --out');
  }
  for (const file of manifest.files) {
    const filename = path.join(directory, file.path), info = await lstat(filename);
    if (!info.isFile() || info.size !== file.bytes) throw new Error('Managed output was modified; choose a fresh --out');
    const bytes = await readFile(filename);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Managed output was modified; choose a fresh --out');
  }
  return manifest;
}

async function removeOwned(directory) {
  const manifest = await owned(directory);
  // Exact owned files only; no recursive deletion, even if an unknown entry appears later.
  for (const file of manifest.files) await unlink(path.join(directory, file.path));
  await unlink(path.join(directory, MANIFEST));
  for (const name of directories(manifest.files.map(file => file.path)).sort((a, b) => b.length - a.length)) await rmdir(path.join(directory, name));
  await rmdir(directory);
}

async function prepare(parent) {
  const stage = await mkdtemp(path.join(parent, '.pactspan-demo-stage-'));
  const entries = [];
  async function put(name, bytes) {
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Generated demo file exceeds its byte bound');
    await mkdir(path.dirname(path.join(stage, name)), { recursive: true });
    await writeFile(path.join(stage, name), bytes, { flag: 'wx', mode: 0o644 });
    entries.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  try {
    for (const [target, source] of sources) await put(target, await sourceBytes(source));
    const local = await sourceBytes(optional[1], true); if (local !== null) await put(optional[0], local);
    const cases = [];
    for (let number = 1; number <= 20; number++) cases.push(JSON.parse((await sourceBytes(`examples/development/D${String(number).padStart(2, '0')}.json`)).toString('utf8')));
    const data = JSON.stringify(cases).replace(/[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
    await put('data/development.mjs', Buffer.from(`// Authored synthetic cases, not model extraction output.\nexport const CASES = ${data};\n`));
    const manifest = { format: FORMAT, files: entries.sort((a, b) => a.path.localeCompare(b.path, 'en')) };
    await writeFile(path.join(stage, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    await owned(stage);
    return { stage, manifest };
  } catch (error) { throw new Error('Build failed; fresh staging retained for inspection at ' + stage, { cause: error }); }
}

export async function buildDemo(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'out')) throw new Error('Use buildDemo({out}) or buildDemo()');
  const out = await outputPath(options.out ?? 'dist'), parent = path.dirname(out);
  const lockPath = path.join(parent, '.' + path.basename(out) + '.pactspan-demo.lock');
  const token = randomUUID(); let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new Error('Output lock exists or cannot be acquired; inspect it or choose a fresh --out'); }
  await lock.writeFile(token); await lock.close();
  let prepared, retired;
  try {
    const previous = await stat(out) ? await owned(out) : null;
    prepared = await prepare(parent);
    if (previous && JSON.stringify(previous) === JSON.stringify(prepared.manifest)) {
      await owned(out); await removeOwned(prepared.stage); prepared = null; return out;
    }
    if (previous) {
      await owned(out);
      retired = await mkdtemp(path.join(parent, '.pactspan-demo-retired-'));
      try { await rename(out, path.join(retired, 'previous')); }
      catch (error) { await rmdir(retired); retired = null; throw error; }
    }
    try {
      if (await stat(out)) throw new Error('Output appeared during the build; refusing replacement');
      await rename(prepared.stage, out); prepared = null;
    }
    catch (error) {
      if (retired && !(await stat(out))) { await owned(path.join(retired, 'previous')); await rename(path.join(retired, 'previous'), out); await rmdir(retired); retired = null; }
      throw error;
    }
    await owned(out);
    if (retired) { await removeOwned(path.join(retired, 'previous')); await rmdir(retired); retired = null; }
    return out;
  } finally {
    if (prepared) await removeOwned(prepared.stage);
    // Never remove a replaced/unknown lock, or an interrupted replacement checkpoint.
    if (!retired && await readFile(lockPath, 'utf8').catch(() => null) === token) await unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node scripts/build-demo.mjs [--out FRESH_DIRECTORY]');
  console.log(await buildDemo(args.length ? { out: args[1] } : {}));
}
