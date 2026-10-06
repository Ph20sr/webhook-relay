#!/usr/bin/env node
// Uso: node bin/webhook-relay.js [relay.config.json]
import { readFileSync } from 'node:fs';
import { createStore, createRelay, createRelayServer } from '../src/index.js';

const configPath = process.argv[2] ?? 'relay.config.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));

// Segredos podem vir do ambiente: "secret": "env:ASAAS_WEBHOOK_TOKEN"
const resolveEnv = (value) => (typeof value === 'string' && value.startsWith('env:') ? process.env[value.slice(4)] : value);
for (const route of Object.values(config.routes)) {
  if (route.verify) route.verify.secret = resolveEnv(route.verify.secret);
  route.signingSecret = resolveEnv(route.signingSecret);
}

const log = (event, data) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
const store = createStore(config.database ?? 'relay.db');
const relay = createRelay({ store, routes: config.routes, maxAttempts: config.maxAttempts ?? 8, log });
const server = createRelayServer({ store, routes: config.routes, adminToken: resolveEnv(config.adminToken) });

const stop = relay.start(config.pollIntervalMs ?? 2000);
const port = Number(process.env.PORT ?? config.port ?? 8787);
server.listen(port, () => log('listening', { port, routes: Object.keys(config.routes) }));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
