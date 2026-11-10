import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoCRM } from '../src/adapters/demo.mjs';

test('separate mutable Demo CRM changes actual fields/revisions and requires a fresh read after ACK', async () => {
  const crm = new DemoCRM({ records: [{ entity_id: 'O1', amount: '12000', currency: 'USD', revision: 7 }], clock: () => '2030-01-08T10:00:00Z' });
  const before = await crm.readOpportunity('O1');
  const ack = await crm.updateAmount({ entityId: 'O1', amount: '10800', currency: 'USD', expectedRevision: before.revision });
  assert.equal(ack.requires_verification, true);
  const after = await crm.readOpportunity('O1');
  assert.equal(after.amount, '10800'); assert.equal(after.revision, '8');
  await assert.rejects(crm.updateAmount({ entityId: 'O1', amount: '10800', currency: 'USD', expectedRevision: before.revision }), /changed/);
  crm.operatorChange('O1', { amount: '12000' });
  assert.equal((await crm.readOpportunity('O1')).revision, '9');
  assert.deepEqual(crm.snapshot().ledger.map(item => item.kind), ['approved_write', 'operator_edit']);
  assert.equal(before.amount, '12000'); assert.equal(after.amount, '10800');
});
