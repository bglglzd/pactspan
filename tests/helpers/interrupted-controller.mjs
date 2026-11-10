import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceController } from '../../src/local/controller.mjs';
import { DiskDemoCRM } from '../../src/local/demo-crm.mjs';

const [directory, approvalId, phase] = process.argv.slice(2);
const clock = () => '2030-01-08T10:00:00.000Z';
const crm = await DiskDemoCRM.open(directory, { clock });
const adapter = {
  readOpportunity: id => crm.readOpportunity(id),
  snapshot: () => crm.snapshot(),
  async updateAmount(command) {
    const response = phase === 'committed' ? await crm.updateAmount(command) : null;
    await writeFile(path.join(directory, 'interruption-ready.json'), JSON.stringify({ phase, pid: process.pid, response }), { flag: 'wx' });
    // The parent kills this process while execute is between its durable pending
    // commit and its outcome commit. No controller shutdown can repair the state.
    await new Promise(() => setInterval(() => {}, 1000));
  },
};
const controller = await WorkspaceController.open({ directory, crm: adapter, clock });
await controller.dispatch('execute', { approval_id: approvalId });
throw new Error('The parent must interrupt the writer before execute finishes');
