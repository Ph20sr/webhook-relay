import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Confere se o webhook veio mesmo do remetente, conforme a rota:
 * - { type: 'token', header, secret }          → header igual ao segredo (ex.: Asaas)
 * - { type: 'hmac-sha256', header, secret, prefix } → HMAC do corpo (ex.: Meta, GitHub)
 */
export function verifyIncoming(verify, headers, body) {
  if (!verify) return true;
  const received = headers[verify.header.toLowerCase()];
  if (typeof received !== 'string') return false;
  if (verify.type === 'token') return safeEqual(received, verify.secret);
  if (verify.type === 'hmac-sha256') {
    const expected = (verify.prefix ?? 'sha256=') + createHmac('sha256', verify.secret).update(body).digest('hex');
    return safeEqual(received, expected);
  }
  throw new Error(`Tipo de verificação desconhecido: ${verify.type}`);
}

/**
 * Chave de idempotência: header configurado, campo do JSON (ex.: "id" ou
 * "event.id") ou, por padrão, o hash do corpo (reenvio idêntico = mesmo evento).
 */
export function idempotencyKey(route, headers, body) {
  const cfg = route.idempotency ?? {};
  if (cfg.header && headers[cfg.header.toLowerCase()]) return `h:${headers[cfg.header.toLowerCase()]}`;
  if (cfg.jsonField) {
    try {
      const value = cfg.jsonField.split('.').reduce((obj, k) => obj?.[k], JSON.parse(body));
      if (value != null && value !== '') return `j:${value}`;
    } catch { /* corpo não é JSON: cai no hash */ }
  }
  return `b:${createHash('sha256').update(body).digest('hex')}`;
}

/** Backoff exponencial com jitter: 10s, 20s, 40s... até `maxDelayMs`. */
export function backoff(attempt, { baseDelayMs = 10_000, maxDelayMs = 3_600_000, random = Math.random } = {}) {
  const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return Math.round(delay * (0.8 + random() * 0.4));
}

export const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/**
 * Motor de entrega: pega os eventos vencidos e faz POST no destino da rota.
 * 2xx = entregue; qualquer outra coisa = nova tentativa com backoff, até
 * `maxAttempts`, quando o evento vai para "dead" (reprocessável manualmente).
 */
export function createRelay({
  store,
  routes,
  fetch: fetchFn = globalThis.fetch,
  maxAttempts = 8,
  timeoutMs = 10_000,
  backoffOptions,
  now = () => Date.now(),
  log = () => {},
}) {
  async function deliver(event) {
    const route = routes[event.source];
    if (!route) {
      store.markFailed(event.id, `Rota "${event.source}" não existe mais`, null);
      return 'dead';
    }
    const attempt = event.attempts + 1;
    const headers = {
      'content-type': event.headers['content-type'] ?? 'application/json',
      'user-agent': 'webhook-relay/1.0',
      'x-relay-event-id': String(event.id),
      'x-relay-source': event.source,
      'x-relay-attempt': String(attempt),
    };
    if (route.signingSecret) headers['x-relay-signature'] = sign(route.signingSecret, event.body);

    try {
      const res = await fetchFn(route.target, {
        method: 'POST',
        headers,
        body: event.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        store.markDelivered(event.id, now());
        log('delivered', { id: event.id, source: event.source, attempt });
        return 'delivered';
      }
      throw new Error(`Destino respondeu HTTP ${res.status}`);
    } catch (err) {
      const giveUp = attempt >= maxAttempts;
      store.markFailed(event.id, err.message, giveUp ? null : now() + backoff(attempt - 1, backoffOptions));
      log(giveUp ? 'dead' : 'retry', { id: event.id, source: event.source, attempt, error: err.message });
      return giveUp ? 'dead' : 'retry';
    }
  }

  /** Processa um lote de eventos vencidos (chamado pelo worker em intervalo). */
  async function tick({ batch = 10, concurrency = 4 } = {}) {
    const due = store.due(now(), batch);
    const results = [];
    for (let i = 0; i < due.length; i += concurrency) {
      results.push(...await Promise.all(due.slice(i, i + concurrency).map(deliver)));
    }
    return results;
  }

  function start(intervalMs = 2000) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try { await tick(); } finally { running = false; }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { deliver, tick, start };
}
