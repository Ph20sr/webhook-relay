import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { verifyIncoming, idempotencyKey } from './relay.js';

const MAX_BODY = 1024 * 1024; // 1 MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Corpo excede 1 MB'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

/** Só os headers úteis ao destino; nunca repassa credenciais de entrada. */
const KEEP_HEADERS = ['content-type', 'user-agent', 'x-request-id', 'idempotency-key'];

export function createRelayServer({ store, routes, adminToken, now = () => Date.now() }) {
  const isAdmin = (req) => {
    if (!adminToken) return false;
    const given = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${adminToken}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://relay');
    try {
      // Entrada de webhooks: POST /in/<rota>
      const inbound = url.pathname.match(/^\/in\/([\w-]+)$/);
      if (inbound && req.method === 'POST') {
        const source = inbound[1];
        const route = routes[source];
        if (!route) return send(res, 404, { error: 'unknown_route' });

        const body = await readBody(req);
        if (!verifyIncoming(route.verify, req.headers, body)) return send(res, 401, { error: 'invalid_signature' });

        const headers = Object.fromEntries(KEEP_HEADERS.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
        const { id, duplicate } = store.insert({
          source, idempotencyKey: idempotencyKey(route, req.headers, body), headers, body, now: now(),
        });
        // 202: recebido e guardado; a entrega é assíncrona
        return send(res, 202, { id, duplicate });
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return send(res, 200, { ok: true, ...store.counts() });
      }

      // Administração (Authorization: Bearer <ADMIN_TOKEN>)
      if (url.pathname.startsWith('/events')) {
        if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });

        if (url.pathname === '/events' && req.method === 'GET') {
          const status = url.searchParams.get('status') ?? undefined;
          const limit = Number(url.searchParams.get('limit') ?? 50);
          return send(res, 200, { events: store.list({ status, limit }) });
        }
        const replay = url.pathname.match(/^\/events\/(\d+)\/replay$/);
        if (replay && req.method === 'POST') {
          return store.replay(Number(replay[1]), now()) ? send(res, 202, { replayed: true }) : send(res, 404, { error: 'not_found' });
        }
        const one = url.pathname.match(/^\/events\/(\d+)$/);
        if (one && req.method === 'GET') {
          const event = store.get(Number(one[1]));
          return event ? send(res, 200, event) : send(res, 404, { error: 'not_found' });
        }
      }

      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'internal_error' });
    }
  });
}
