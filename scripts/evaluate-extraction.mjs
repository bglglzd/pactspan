import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeSource } from '../src/core/source.mjs';
import { canonical } from '../src/core/data.mjs';
import { extractCandidates, extractionConfig } from '../src/adapters/extract.mjs';
import { scoreExtractions } from '../src/evaluation/extraction.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function atomic(filename, value) {
  const temporary = filename + '.pending'; await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, filename);
}

export async function evaluate({ dataset, out, options, split = 'development' }) {
  if (!['development', 'held-out'].includes(split)) throw new Error('Split must be development or held-out');
  // An existing directory is never overwritten: first-run evidence and failures survive.
  await mkdir(out, { mode: 0o700 });
  const root = new URL('../', import.meta.url);
  const files = ['src/adapters/extract.mjs', 'src/adapters/extraction-prompt.mjs', 'src/adapters/deadline.mjs',
    'src/core/data.mjs', 'src/core/source.mjs', 'src/core/terms.mjs', 'src/core/money.mjs',
    'src/evaluation/extraction.mjs', 'scripts/evaluate-extraction.mjs'];
  const sourceFiles = [];
  for (const name of files) sourceFiles.push({ path: name, sha256: hash(await readFile(new URL(name, root))) });
  const names = (await readdir(dataset)).filter(name => /^(?:D|H)\d\d\.json$/.test(name)).sort();
  if (!names.length) throw new Error('Dataset contains no Dnn/Hnn JSON cases');
  if (names.some(name => !name.startsWith(split === 'development' ? 'D' : 'H'))) throw new Error('Dataset case prefix does not match the declared split');
  const fixtures = []; const datasetFiles = [];
  for (const name of names) { const bytes = await readFile(path.join(dataset, name)); datasetFiles.push({ path: name, sha256: hash(bytes) }); fixtures.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  const config = extractionConfig(options);
  const identity = { schema_version: 1, split, started_at: new Date().toISOString(), pid: process.pid, node: process.version,
    versions: process.versions, platform: process.platform, architecture: process.arch, logical_cpus: os.cpus().length,
    config, source_files: sourceFiles, source_files_sha256: hash(canonical(sourceFiles)), dataset_files: datasetFiles,
    dataset_sha256: hash(canonical(datasetFiles)), scope: 'One sequential model request per canonical source; no retry, fallback, fixture substitution or best-of selection. Gold is used only by the evaluator after inference.',
    cost_scope: 'Local inference only; no paid API requests. Hardware, energy and operator costs are not measured.' };
  await atomic(path.join(out, 'identity.json'), identity);
  const runs = [];
  for (const fixture of fixtures) for (const [sourceIndex, raw] of fixture.sources.entries()) {
    const source = await makeSource(raw);
    const stem = `${fixture.id}-${String(sourceIndex).padStart(2, '0')}`;
    const run = { case_id: fixture.id, source_alias: raw.id, source_id: source.id, started_at: new Date().toISOString(), config_sha256: config.config_sha256 };
    // The pending marker precedes the request. An interrupted call is never silently
    // retried; retain this marker and reconcile it as an incomplete first attempt.
    await atomic(path.join(out, stem + '-started.json'), { ...run, source_sha256: hash(canonical(source)), status: 'pending' });
    const started = performance.now();
    try { run.result = await extractCandidates(source, options); }
    catch (error) { run.failure = { code: error.code ?? 'unexpected', message: error.message, evidence: error.evidence ?? null }; }
    run.elapsed_ms = performance.now() - started; run.finished_at = new Date().toISOString(); runs.push(run);
    await atomic(path.join(out, stem + '.json'), run);
    await atomic(path.join(out, 'status.json'), { state: 'running', completed_sources: runs.length, last: stem, last_status: run.failure?.code ?? run.result.status });
    console.log(JSON.stringify({ source: stem, status: run.failure?.code ?? run.result.status,
      raw_candidate_count: run.result?.raw_candidate_count ?? run.failure?.evidence?.raw_candidate_count ?? null, elapsed_ms: run.elapsed_ms }));
  }
  const report = await scoreExtractions(fixtures, runs);
  await atomic(path.join(out, 'runs.json'), runs); await atomic(path.join(out, 'report.json'), report);
  await atomic(path.join(out, 'status.json'), { state: 'completed', completed_sources: runs.length, finished_at: new Date().toISOString(), report_sha256: hash(await readFile(path.join(out, 'report.json'))) });
  return { identity, report };
}

async function main() {
  const args = process.argv.slice(2); const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--dataset', '--out', '--origin', '--model', '--split', '--max-tokens', '--timeout-ms'].includes(name) || Object.hasOwn(flags, name) || !args[index + 1]) throw new Error('Use --dataset --out --origin --model [--split development|held-out] [--max-tokens N] [--timeout-ms N]');
    flags[name] = args[index + 1];
  }
  for (const required of ['--dataset', '--out', '--origin', '--model']) if (!flags[required]) throw new Error('Missing ' + required);
  const options = { origin: flags['--origin'], model: flags['--model'], maxTokens: Number(flags['--max-tokens'] ?? 2048), timeoutMs: Number(flags['--timeout-ms'] ?? 120000) };
  await evaluate({ dataset: path.resolve(flags['--dataset']), out: path.resolve(flags['--out']), options, split: flags['--split'] ?? 'development' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
