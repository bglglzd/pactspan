import { DemoCRM } from '../adapters/demo.mjs';
import { fields, requireValue, sha256 } from '../core/data.mjs';
import { privateRead, privateWrite } from './files.mjs';

// This file is an independent synthetic external store, separate from the domain ledger.
export class DiskDemoCRM {
  #root; #clock; #crm;
  static async open(root, { clock, records = [] } = {}) {
    const instance = new DiskDemoCRM(); instance.#root = root; instance.#clock = clock;
    const raw = await privateRead(root, 'demo-crm.json');
    if (raw !== null) {
      let value; try { value = JSON.parse(raw); } catch { throw new Error('Synthetic CRM data is damaged; preserve demo-crm.json before recovery'); }
      fields(value, ['schema_version', 'data', 'sha256'], 'Disk Demo CRM');
      requireValue(value.schema_version === 1 && await sha256(value.data) === value.sha256, 'Synthetic CRM integrity check failed');
      instance.#crm = new DemoCRM({ ...value.data, clock });
    } else { instance.#crm = new DemoCRM({ records, clock }); await instance.#save(instance.#crm); }
    return instance;
  }
  snapshot() { return this.#crm.snapshot(); }
  readOpportunity(id) { return this.#crm.readOpportunity(id); }
  async #save(crm) {
    const data = crm.snapshot();
    await privateWrite(this.#root, 'demo-crm.json', { schema_version: 1, data, sha256: await sha256(data) });
    this.#crm = crm;
  }
  async updateAmount(command) {
    const next = new DemoCRM({ ...this.snapshot(), clock: this.#clock });
    const result = await next.updateAmount(command); await this.#save(next); return result;
  }
  async operatorChange(id, values) {
    const next = new DemoCRM({ ...this.snapshot(), clock: this.#clock });
    const result = next.operatorChange(id, values); await this.#save(next); return result;
  }
  async reset(records) { await this.#save(new DemoCRM({ records, clock: this.#clock })); }
}
