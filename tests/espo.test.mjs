import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inspect } from 'node:util';
import { EspoCRM, EspoError } from '../src/adapters/espo.mjs';

const READ_KEY = 'synthetic-reader-key-private';
const WRITE_KEY = 'synthetic-writer-key-private';
const row = (extra = {}) => ({ id: 'O1', deleted: false, amount: 12000, amountCurrency: 'USD', versionNumber: 1, ...extra });
const update = (extra = {}) => ({ entityId: 'O1', amount: '10800', currency: 'USD', expectedRevision: '1', ...extra });

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function server(t, handler, options = {}) {
  const calls = [];
  const instance = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const call = { method: request.method, path: request.url, key: request.headers['x-api-key'],
      revision: request.headers['x-version-number'], body: raw ? JSON.parse(raw) : null };
    calls.push(call);
    await handler(call, request, response);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  const origin = `http://127.0.0.1:${instance.address().port}`;
  return { calls, origin, client: new EspoCRM({ origin, readKey: READ_KEY, writeKey: WRITE_KEY, ...options }) };
}

function errorCode(code) {
  return error => {
    assert.ok(error instanceof EspoError);
    assert.equal(error.code, code);
    const visible = inspect(error) + JSON.stringify(error) + error.stack;
    assert.ok(!visible.includes(READ_KEY) && !visible.includes(WRITE_KEY));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('configuration keeps keys private and rejects ambiguous origins or credentials', () => {
  const base = { readKey: READ_KEY, writeKey: WRITE_KEY };
  for (const origin of ['http://example.com', 'ftp://127.0.0.1', 'http://user:pass@127.0.0.1',
    ' http://127.0.0.1', 'http://127.0.0.1\n', 'http://127.0.0.1/api', 'https://example.com?q=x',
    'https://example.com#fragment', 'http://127.0.0.1:0']) {
    assert.throws(() => new EspoCRM({ origin, ...base }), errorCode('configuration'));
  }
  assert.throws(() => new EspoCRM({ origin: 'https://example.com', ...base, extra: READ_KEY }), errorCode('configuration'));
  assert.throws(() => new EspoCRM({ origin: 'http://127.0.0.1', ...base, writeKey: READ_KEY }), errorCode('configuration'));
  assert.throws(() => new EspoCRM({ origin: 'http://127.0.0.1', ...base, readKey: 'bad\r\nkey' }), errorCode('configuration'));
  const client = new EspoCRM({ origin: 'https://example.com', ...base });
  assert.equal(JSON.stringify(client), '{}');
  assert.ok(!inspect(client).includes(READ_KEY) && !inspect(client).includes(WRITE_KEY));
});

test('fresh read returns only a canonical sanitized observation with its own digest', async t => {
  let description = READ_KEY;
  const { client, calls } = await server(t, (_call, _request, response) => json(response, row({ amount: 10800.50, description })));
  const first = await client.readOpportunity('O1');
  description = 'Other ignored business text';
  const second = await client.readOpportunity('O1');
  assert.equal(first.amount, '10800.5');
  assert.equal(first.currency, 'USD');
  assert.equal(first.revision, '1');
  assert.equal(first.mode, 'single-writer-sandbox');
  assert.match(first.observed_at, /^\d{4}-\d\d-\d\dT/);
  assert.match(first.response_sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.response_sha256, second.response_sha256);
  assert.ok(!JSON.stringify(first).includes(READ_KEY));
  assert.deepEqual(calls.map(call => [call.method, call.path, call.key]),
    [['GET', '/api/v1/Opportunity/O1', READ_KEY], ['GET', '/api/v1/Opportunity/O1', READ_KEY]]);
});

test('wrong identity, deletion, invalid numeric values, missing fields and revisions cannot become observations', async t => {
  const bad = [null, [], row({ id: 'O2' }), row({ deleted: true }), row({ deleted: undefined }),
    row({ amount: '10800' }), row({ amount: -1 }), row({ amount: 0.30000000000000004 }),
    row({ amount: 1e10 }), row({ amountCurrency: 'usd' }), row({ versionNumber: 0 }),
    row({ versionNumber: '1' }), row({ versionNumber: Number.MAX_SAFE_INTEGER + 1 })];
  let selected;
  const { client } = await server(t, (_call, _request, response) => json(response, selected));
  for (selected of bad) await assert.rejects(client.readOpportunity('O1'), errorCode('invalid_response'));
});

test('malformed JSON, nonfinite exponent and invalid UTF-8 are rejected without response contents in errors', async t => {
  let selected;
  const { client } = await server(t, (_call, _request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(selected);
  });
  for (selected of ['{"id":', '{"amount":NaN}', JSON.stringify(row()).replace('12000', '1e400'), Buffer.from([0xff])]) {
    await assert.rejects(client.readOpportunity('O1'), errorCode('invalid_response'));
  }
});

test('response byte limits cover declared and chunked bodies and timeout covers an unfinished body', async t => {
  let mode = 'declared';
  const { client } = await server(t, (_call, _request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', ...(mode === 'declared' ? { 'Content-Length': '65537' } : {}) });
    if (mode === 'stalled') response.write('{"id":');
    else response.end('x'.repeat(65537));
  }, { timeoutMs: 100 });
  await assert.rejects(client.readOpportunity('O1'), errorCode('response_limit'));
  mode = 'chunked';
  await assert.rejects(client.readOpportunity('O1'), errorCode('response_limit'));
  mode = 'stalled';
  await assert.rejects(client.readOpportunity('O1'), errorCode('timeout'));
});

test('redirects never send a credential to the redirect destination', async t => {
  const sink = await server(t, (_call, _request, response) => json(response, row()));
  const source = await server(t, (_call, _request, response) => {
    response.writeHead(302, { Location: sink.origin + '/api/v1/Opportunity/O1' }); response.end();
  });
  await assert.rejects(source.client.readOpportunity('O1'), errorCode('transport'));
  assert.equal(sink.calls.length, 0);
});

test('single-writer consent, known fields and canonical revision are checked before any HTTP call', async t => {
  const { client, calls } = await server(t, (_call, _request, response) => json(response, row()));
  await assert.rejects(client.updateAmount(update()), errorCode('single_writer_required'));
  for (const value of [update({ expectedRevision: '01' }), update({ expectedRevision: 1 }), update({ entityId: '../O1' }),
    update({ amount: 10800 }), update({ receipt: { fulfilled: true } })]) {
    await assert.rejects(client.updateAmount(value), errorCode('invalid_input'));
  }
  assert.equal(calls.length, 0);
});

test('fresh preflight mismatch refuses the PUT instead of updating the approval revision', async t => {
  const { client, calls } = await server(t, (_call, _request, response) => json(response, row({ versionNumber: 2 })), { singleWriter: true });
  await assert.rejects(client.updateAmount(update()), errorCode('conflict'));
  assert.deepEqual(calls.map(call => call.method), ['GET']);
});

test('update sends only approved fields and returns acknowledgement; verification needs a separate reader GET', async t => {
  let current = row();
  const { client, calls } = await server(t, (call, _request, response) => {
    if (call.method === 'PUT') current = row({ ...call.body, versionNumber: 2 });
    json(response, current);
  }, { singleWriter: true });
  const ack = await client.updateAmount(update({ amount: '10800.00' }));
  assert.equal(ack.kind, 'write-acknowledgement');
  assert.equal(ack.requires_verification, true);
  assert.equal(ack.receipt, undefined);
  assert.equal(ack.fulfilled, undefined);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT']);
  assert.deepEqual(calls[1], { method: 'PUT', path: '/api/v1/Opportunity/O1', key: WRITE_KEY,
    revision: '1', body: { amount: 10800, amountCurrency: 'USD' } });
  const observed = await client.readOpportunity('O1');
  assert.equal(observed.amount, '10800');
  assert.equal(observed.revision, '2');
  assert.equal(calls[2].key, READ_KEY);
  await assert.rejects(client.updateAmount(update()), errorCode('conflict'));
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});

test('403 and explicit409/412 remain typed refusals without reflected peer secrets or retries', async t => {
  let status = 403;
  const { client, calls } = await server(t, (call, _request, response) => {
    if (call.method === 'GET') json(response, row());
    else json(response, { error: READ_KEY + WRITE_KEY }, status);
  }, { singleWriter: true });
  await assert.rejects(client.updateAmount(update()), errorCode('denied'));
  for (status of [409, 412]) await assert.rejects(client.updateAmount(update()), errorCode('conflict'));
  assert.equal(calls.filter(call => call.method === 'PUT').length, 3);
});

test('lost acknowledgement commits once, remains uncertain, and is reconciled by a reader without implicit retry', async t => {
  let current = row();
  const { client, calls } = await server(t, (call, request, response) => {
    if (call.method === 'PUT') { current = row({ ...call.body, versionNumber: 2 }); request.socket.destroy(); }
    else json(response, current);
  }, { singleWriter: true });
  await assert.rejects(client.updateAmount(update()), errorCode('uncertain_outcome'));
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT']);
  assert.equal((await client.readOpportunity('O1')).amount, '10800');
  await assert.rejects(client.updateAmount(update()), errorCode('conflict'));
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});

test('HTTP408 after a committed write remains uncertain and needs a fresh read', async t => {
  let current = row();
  const { client, calls } = await server(t, (call, _request, response) => {
    if (call.method === 'PUT') {
      current = row({ ...call.body, versionNumber: 2 });
      json(response, { intermediary: 'Request timeout', reflected: WRITE_KEY }, 408);
    } else json(response, current);
  }, { singleWriter: true });
  await assert.rejects(client.updateAmount(update()), errorCode('uncertain_outcome'));
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal((await client.readOpportunity('O1')).amount, '10800');
});

test('timeout, invalid acknowledgement, wrong postvalue, oversized response and5xx after PUT are uncertain', async t => {
  let mode;
  const { client, calls } = await server(t, (call, _request, response) => {
    if (call.method === 'GET') return json(response, row());
    if (mode === 'timeout') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); return; }
    if (mode === '5xx') return json(response, { detail: WRITE_KEY }, 503);
    if (mode === 'wrong-value') return json(response, row({ amount: 1, versionNumber: 2 }));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(mode === 'large' ? 'x'.repeat(65537) : '{');
  }, { singleWriter: true, timeoutMs: 100 });
  for (mode of ['timeout', 'malformed', 'wrong-value', 'large', '5xx']) {
    const count = calls.length;
    await assert.rejects(client.updateAmount(update()), errorCode('uncertain_outcome'));
    assert.deepEqual(calls.slice(count).map(call => call.method), ['GET', 'PUT']);
  }
});

test('one client refuses overlapping writes while the caller retains cross-process exclusivity responsibility', async t => {
  let unblock;
  const ready = new Promise(resolve => { unblock = resolve; });
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const { client, calls } = await server(t, async (call, _request, response) => {
    if (call.method === 'GET') { unblock(); await wait; json(response, row()); }
    else json(response, row({ amount: 10800, versionNumber: 2 }));
  }, { singleWriter: true });
  const pending = client.updateAmount(update());
  await ready;
  await assert.rejects(client.updateAmount(update()), errorCode('busy'));
  finish();
  await pending;
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT']);
});
