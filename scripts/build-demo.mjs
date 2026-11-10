import { mkdir, readFile, readdir, cp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildDemo() {
  const dist = path.join(root, 'dist');
  await mkdir(dist, { recursive: true });
  await cp(path.join(root, 'public'), dist, { recursive: true });
  await cp(path.join(root, 'src/core'), path.join(dist, 'core'), { recursive: true });
  await mkdir(path.join(dist, 'adapters'), { recursive: true });
  await cp(path.join(root, 'src/adapters/demo.mjs'), path.join(dist, 'adapters/demo.mjs'));
  const cases = [];
  for (const name of (await readdir(path.join(root, 'examples/development'))).filter(name => /^D\d\d\.json$/.test(name)).sort()) {
    cases.push(JSON.parse(await readFile(path.join(root, 'examples/development', name), 'utf8')));
  }
  await mkdir(path.join(dist, 'data'), { recursive: true });
  const data = JSON.stringify(cases).replace(/[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  await writeFile(path.join(dist, 'data/development.mjs'), `// Authored synthetic cases, not model extraction output.\nexport const CASES = ${data};\n`, 'utf8');
  return dist;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildDemo());
}
