import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import {
  createStore, createRelay, createRelayServer, verifyIncoming, idempotencyKey, backoff, sign,
} from '../src/index.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((r) => server.close(r));

/** Destino de teste: responde com os status da fila e registra o que recebeu. */
async function startTarget(statuses = []) {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(statuses.shift() ?? 200).end();
    });
  });
  return { url: await listen(server), received, server };
}

async function setup({ targetStatuses, routeExtra = {}, maxAttempts = 3 } = {}) {
  const target = await startTarget(targetStatuses);
  let clock = 1_000_000;
  const store = createStore(':memory:');
  const routes = { asaas: { target: target.url, signingSecret: 'out-secret', ...routeExtra } };
  const relay = createRelay({
    store, routes, maxAttempts, now: () => clock, backoffOptions: { baseDelayMs: 1000, random: () => 0.5 },
  });
  const server = createRelayServer({ store, routes, adminToken: 'adm', now: () => clock });
  const base = await listen(server);
  return {
    target, store, relay, base,
    advance: (ms) => { clock += ms; },
    async teardown() { await close(server); await close(target.server); store.close(); },
  };
}

const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
});

test('recebe, guarda (202) e entrega assinado', async () => {
  const t = await setup();
  try {
    const body = JSON.stringify({ id: 'evt_1', event: 'PAYMENT_RECEIVED' });
    const res = await post(`${t.base}/in/asaas`, body);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { id: 1, duplicate: false });

    assert.deepEqual(await t.relay.tick(), ['delivered']);
    const [delivery] = t.target.received;
    assert.equal(delivery.body, body);
    assert.equal(delivery.headers['x-relay-source'], 'asaas');
    assert.equal(delivery.headers['x-relay-attempt'], '1');
    assert.equal(delivery.headers['x-relay-signature'], sign('out-secret', body));
    assert.equal(t.store.get(1).status, 'delivered');
  } finally {
    await t.teardown();
  }
});

test('reenvio do mesmo webhook não duplica', async () => {
  const t = await setup({ routeExtra: { idempotency: { jsonField: 'id' } } });
  try {
    await post(`${t.base}/in/asaas`, '{"id":"evt_9","n":1}');
    const again = await post(`${t.base}/in/asaas`, '{"id":"evt_9","n":2}');
    assert.deepEqual(await again.json(), { id: 1, duplicate: true });
    await t.relay.tick();
    assert.equal(t.target.received.length, 1);
  } finally {
    await t.teardown();
  }
});

test('falha no destino: backoff exponencial e "dead" após o limite', async () => {
  const t = await setup({ targetStatuses: [500, 503, 500], maxAttempts: 3 });
  try {
    await post(`${t.base}/in/asaas`, '{"id":"x"}');

    assert.deepEqual(await t.relay.tick(), ['retry']);
    assert.deepEqual(await t.relay.tick(), [], 'ainda não venceu');
    t.advance(1000); // 1ª espera = base (1s)
    assert.deepEqual(await t.relay.tick(), ['retry']);
    t.advance(1999);
    assert.deepEqual(await t.relay.tick(), [], '2ª espera = 2s');
    t.advance(1);
    assert.deepEqual(await t.relay.tick(), ['dead']);

    const event = t.store.get(1);
    assert.equal(event.status, 'dead');
    assert.equal(event.attempts, 3);
    assert.match(event.lastError, /HTTP 500/);
  } finally {
    await t.teardown();
  }
});

test('admin: lista e reprocessa eventos mortos', async () => {
  const t = await setup({ targetStatuses: [500], maxAttempts: 1 });
  try {
    await post(`${t.base}/in/asaas`, '{"id":"y"}');
    await t.relay.tick();

    assert.equal((await fetch(`${t.base}/events?status=dead`)).status, 401, 'exige token');
    const auth = { authorization: 'Bearer adm' };
    const list = await (await fetch(`${t.base}/events?status=dead`, { headers: auth })).json();
    assert.equal(list.events.length, 1);

    const replay = await fetch(`${t.base}/events/1/replay`, { method: 'POST', headers: auth });
    assert.equal(replay.status, 202);
    assert.deepEqual(await t.relay.tick(), ['delivered']);

    const health = await (await fetch(`${t.base}/health`)).json();
    assert.deepEqual(health, { ok: true, pending: 0, delivered: 1, dead: 0 });
  } finally {
    await t.teardown();
  }
});

test('verificação de origem: token e HMAC', async () => {
  const t = await setup({ routeExtra: { verify: { type: 'token', header: 'asaas-access-token', secret: 's3cr3t-token' } } });
  try {
    assert.equal((await post(`${t.base}/in/asaas`, '{}')).status, 401);
    assert.equal((await post(`${t.base}/in/asaas`, '{}', { 'asaas-access-token': 'errado' })).status, 401);
    assert.equal((await post(`${t.base}/in/asaas`, '{}', { 'asaas-access-token': 's3cr3t-token' })).status, 202);
    assert.equal((await post(`${t.base}/in/nao-existe`, '{}')).status, 404);
  } finally {
    await t.teardown();
  }

  const body = '{"object":"whatsapp_business_account"}';
  const verify = { type: 'hmac-sha256', header: 'X-Hub-Signature-256', secret: 'app' };
  const good = `sha256=${createHmac('sha256', 'app').update(body).digest('hex')}`;
  assert.equal(verifyIncoming(verify, { 'x-hub-signature-256': good }, body), true);
  assert.equal(verifyIncoming(verify, { 'x-hub-signature-256': good }, `${body} `), false);
});

test('não repassa credenciais recebidas ao destino', async () => {
  const t = await setup({ routeExtra: { verify: { type: 'token', header: 'asaas-access-token', secret: 's3cr3t-token' } } });
  try {
    await post(`${t.base}/in/asaas`, '{"a":1}', { 'asaas-access-token': 's3cr3t-token', cookie: 'sess=1' });
    await t.relay.tick();
    const { headers } = t.target.received[0];
    assert.equal(headers['asaas-access-token'], undefined);
    assert.equal(headers.cookie, undefined);
  } finally {
    await t.teardown();
  }
});

test('idempotencyKey e backoff', () => {
  assert.equal(idempotencyKey({ idempotency: { header: 'X-GitHub-Delivery' } }, { 'x-github-delivery': 'abc' }, '{}'), 'h:abc');
  assert.equal(idempotencyKey({ idempotency: { jsonField: 'event.id' } }, {}, '{"event":{"id":7}}'), 'j:7');
  assert.match(idempotencyKey({ idempotency: { jsonField: 'id' } }, {}, 'não json'), /^b:[0-9a-f]{64}$/);
  assert.equal(idempotencyKey({}, {}, 'x'), idempotencyKey({}, {}, 'x'));

  const mid = { random: () => 0.5 };
  assert.equal(backoff(0, mid), 10_000);
  assert.equal(backoff(3, mid), 80_000);
  assert.equal(backoff(20, mid), 3_600_000, 'limitado a 1h');
  assert.equal(backoff(0, { random: () => 0 }), 8_000, 'jitter de ±20%');
});
