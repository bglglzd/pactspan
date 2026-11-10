#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EspoCRM } from './adapters/espo.mjs';
import { WorkspaceController } from './local/controller.mjs';
import { startServer } from './local/server.mjs';
import { buildDemo } from '../scripts/build-demo.mjs';

export async function main(args = process.argv.slice(2)) {
  const [command = 'help', ...rest] = args;
  if (command === 'help' || command === '--help') {
    console.log('pactspan serve [--data .pactspan] [--port 0] [--crm demo|espocrm] [--keys /private/identities.json] [--example D01]\npactspan action <action.json> [--data .pactspan] [--crm demo|espocrm] [--keys /private/identities.json]\npactspan export [--data .pactspan] [--crm demo|espocrm] [--keys /private/identities.json]\nEspoCRM: PACTSPAN_CRM_ORIGIN, PACTSPAN_SINGLE_WRITER=1; keys via --keys or PACTSPAN_READ_KEY/PACTSPAN_WRITE_KEY.\nOptional loopback model: PACTSPAN_MODEL_ORIGIN and PACTSPAN_MODEL.'); return;
  }
  if (!['serve', 'action', 'export'].includes(command)) throw new Error('Use serve, action, export or help');
  const options = {}; let actionFile = null;
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (command === 'action' && !actionFile && !name.startsWith('--')) { actionFile = name; continue; }
    if (!['--data', '--port', '--crm', '--keys', '--example'].includes(name) || Object.hasOwn(options, name) || !rest[index + 1] || rest[index + 1].startsWith('--')) throw new Error('Invalid or repeated command option');
    options[name] = rest[++index];
  }
  if (command !== 'serve' && (options['--port'] || options['--example'])) throw new Error('Port/example options require serve');
  const adapter = options['--crm'] ?? 'demo'; let crm = null; let target;
  if (!['demo', 'espocrm'].includes(adapter)) throw new Error('CRM must be demo or espocrm');
  if (adapter === 'espocrm') {
    let readKey = process.env.PACTSPAN_READ_KEY; let writeKey = process.env.PACTSPAN_WRITE_KEY;
    if (options['--keys']) {
      const bytes = await readFile(options['--keys']); if (bytes.length > 16_384) throw new Error('Key file exceeds its limit');
      let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Key file must be JSON'); }
      readKey = value.reader?.apiKey; writeKey = value.writer?.apiKey;
    }
    if (process.env.PACTSPAN_SINGLE_WRITER !== '1') throw new Error('EspoCRM requires explicit PACTSPAN_SINGLE_WRITER=1 in a dedicated sandbox');
    crm = new EspoCRM({ origin: process.env.PACTSPAN_CRM_ORIGIN, readKey, writeKey, singleWriter: true });
    target = { adapter: 'espocrm', mode: 'single-writer-sandbox', origin: new URL(process.env.PACTSPAN_CRM_ORIGIN).origin };
  } else if (options['--keys']) throw new Error('Synthetic mode does not use keys');
  let extraction = null;
  if (process.env.PACTSPAN_MODEL_ORIGIN || process.env.PACTSPAN_MODEL) extraction = { origin: process.env.PACTSPAN_MODEL_ORIGIN, model: process.env.PACTSPAN_MODEL,
    maxTokens: Number(process.env.PACTSPAN_MODEL_MAX_TOKENS ?? 2048), timeoutMs: Number(process.env.PACTSPAN_MODEL_TIMEOUT_MS ?? 120000) };
  const controller = await WorkspaceController.open({ directory: path.resolve(options['--data'] ?? '.pactspan'), crm, ...(target ? { target } : {}), extraction });
  try {
    if (command === 'export') { console.log(await controller.export()); await controller.close(); return; }
    if (command === 'action') {
      if (!actionFile) throw new Error('Provide an action JSON file');
      const bytes = await readFile(actionFile); if (bytes.length > 1024 * 1024) throw new Error('Action file exceeds 1 MiB');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (Object.keys(value).some(key => !['action', 'args'].includes(key))) throw new Error('Action file contains unknown fields');
      console.log(JSON.stringify(await controller.dispatch(value.action, value.args), null, 2)); await controller.close(); return;
    }
    if (options['--example']) await controller.dispatch('loadExample', { id: options['--example'] });
    const rawPort = options['--port'] ?? '0'; if (!/^\d{1,5}$/.test(rawPort)) throw new Error('Port must be an integer');
    const hosted = await startServer({ controller, staticRoot: await buildDemo(), port: Number(rawPort) });
    console.log(JSON.stringify({ local_url: hosted.origin, pid: process.pid, crm: adapter, extraction: Boolean(extraction) }));
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (closing) return; closing = true; await hosted.close(); await controller.close(); process.exitCode = 0;
    });
  } catch (error) { await controller.close(); throw error; }
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath && invokedPath === await realpath(fileURLToPath(import.meta.url))) main().catch(error => {
  const safe = ['InputError', 'EspoError', 'ExtractionError', 'WorkspaceStoreError'].includes(error.name);
  console.error(safe ? error.message : 'Pactspan could not start or complete the action. Check command options, data directory and private server configuration.'); process.exitCode = 1;
});
