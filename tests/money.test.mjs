import test from 'node:test';
import assert from 'node:assert/strict';
import { amount, currencyCode, wireAmount } from '../src/core/money.mjs';

test('commercial amounts retain decimal meaning through normalization and the supported wire range', () => {
  assert.equal(amount('10800.00'), '10800');
  assert.equal(amount('0.10'), '0.1');
  assert.equal(amount(String(wireAmount('999999999.99'))), '999999999.99');
  for (const input of [10800, '1e3', '-1', '0100', '0.30000000000000004', '1000000000.01']) assert.throws(() => amount(input));
  assert.equal(currencyCode('USD'), 'USD');
  assert.throws(() => currencyCode('usd'));
});
