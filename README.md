# webhook-relay

[![CI](https://github.com/Ph20sr/webhook-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/Ph20sr/webhook-relay/actions/workflows/ci.yml)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

Uma "caixa postal" de webhooks na frente do seu sistema. Recebe os avisos de **Asaas, WhatsApp, GitHub** ou de qualquer serviço, **confere a origem**, **guarda em SQLite** e **reenvia ao seu sistema com retentativas**. Se a sua API cair no meio de um pagamento, o aviso não se perde.

Usa só Node.js 22.13+, com `node:sqlite` nativo e zero dependências.

## O problema

Webhook é "dispara e esquece". Durante um deploy, uma queda do banco ou um erro 500, o aviso de pagamento confirmado bate na porta fechada. Alguns provedores reenviam algumas vezes e depois desistem. Outros pausam a fila inteira depois de erros seguidos.

```
Asaas / WhatsApp / GitHub ──► webhook-relay ──► seu sistema
                               │  valida origem (token ou HMAC)
                               │  guarda (SQLite) e responde 202 na hora
                               │  entrega com retentativa e backoff
                               └─ eventos "dead" ficam para reprocessar
```

## Recursos

- **Responde 202 imediatamente**: o provedor nunca vê timeout nem erro do seu sistema
- **Validação de origem** por token no header (Asaas) ou **HMAC-SHA256** do corpo (Meta, GitHub)
- **Idempotência**: o mesmo evento reenviado não é entregue duas vezes (por header, campo do JSON ou hash do corpo)
- **Retentativas** com backoff exponencial e jitter (10 s, 20 s, 40 s... até 1 h) e, depois do limite, status `dead`
- **Reprocessamento**: `POST /events/:id/replay` depois de corrigir o bug
- **Entrega assinada**: header `x-relay-signature` (HMAC) para o seu sistema confiar no relay
- **Não vaza credenciais**: tokens e cookies recebidos não são repassados
- `GET /health` com contagem de pendentes, entregues e mortos, para monitoramento

## Uso

```bash
cp relay.config.example.json relay.config.json
export RELAY_ADMIN_TOKEN=... ASAAS_WEBHOOK_TOKEN=... RELAY_SIGNING_SECRET=...
npm start
```

```json
{
  "routes": {
    "asaas": {
      "target": "https://api.seusistema.com.br/webhooks/asaas",
      "verify": { "type": "token", "header": "asaas-access-token", "secret": "env:ASAAS_WEBHOOK_TOKEN" },
      "idempotency": { "jsonField": "id" },
      "signingSecret": "env:RELAY_SIGNING_SECRET"
    },
    "whatsapp": {
      "target": "https://api.seusistema.com.br/webhooks/whatsapp",
      "verify": { "type": "hmac-sha256", "header": "x-hub-signature-256", "secret": "env:WA_APP_SECRET" }
    }
  }
}
```

No painel do Asaas, a URL do webhook passa a ser `https://relay.seudominio.com.br/in/asaas`.

### Administração

```bash
curl -H "Authorization: Bearer $RELAY_ADMIN_TOKEN" "https://relay.../events?status=dead"
curl -X POST -H "Authorization: Bearer $RELAY_ADMIN_TOKEN" https://relay.../events/42/replay
curl https://relay.../health   # {"ok":true,"pending":0,"delivered":1532,"dead":1}
```

### No seu sistema

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const expected = 'sha256=' + createHmac('sha256', process.env.RELAY_SIGNING_SECRET).update(rawBody).digest('hex');
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-relay-signature'] ?? ''));
// x-relay-event-id e x-relay-attempt também chegam nos headers
```

### Como biblioteca

```js
import { createStore, createRelay, createRelayServer } from 'webhook-relay';

const store = createStore('relay.db');
const relay = createRelay({ store, routes, maxAttempts: 8, log: console.log });
createRelayServer({ store, routes, adminToken }).listen(8787);
relay.start(2000);
```

## Testes

```bash
npm test
```

Os testes sobem o relay e um servidor de destino reais em portas locais. Eles cobrem entrega, idempotência, backoff com relógio controlado, eventos mortos, reprocessamento, validação de origem e o não repasse de credenciais.

## Licença

MIT
