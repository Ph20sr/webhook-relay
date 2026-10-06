import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL,
  headers         TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending | delivered | dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  received_at     INTEGER NOT NULL,
  delivered_at    INTEGER,
  UNIQUE (source, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_events_due ON events (status, next_attempt_at);
`;

const row = (r) => r && {
  id: Number(r.id),
  source: r.source,
  idempotencyKey: r.idempotency_key,
  headers: JSON.parse(r.headers),
  body: r.body,
  status: r.status,
  attempts: Number(r.attempts),
  nextAttemptAt: Number(r.next_attempt_at),
  lastError: r.last_error,
  receivedAt: Number(r.received_at),
  deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at),
};

/** Fila persistente em SQLite (node:sqlite, sem dependências). */
export function createStore(path = 'relay.db') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const stmts = {
    insert: db.prepare(`INSERT INTO events (source, idempotency_key, headers, body, next_attempt_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (source, idempotency_key) DO NOTHING`),
    byKey: db.prepare('SELECT id FROM events WHERE source = ? AND idempotency_key = ?'),
    get: db.prepare('SELECT * FROM events WHERE id = ?'),
    due: db.prepare(`SELECT * FROM events WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at, id LIMIT ?`),
    delivered: db.prepare(`UPDATE events SET status = 'delivered', attempts = attempts + 1,
      delivered_at = ?, last_error = NULL WHERE id = ?`),
    failed: db.prepare(`UPDATE events SET attempts = attempts + 1, last_error = ?,
      status = CASE WHEN ? THEN 'dead' ELSE 'pending' END, next_attempt_at = ? WHERE id = ?`),
    replay: db.prepare(`UPDATE events SET status = 'pending', next_attempt_at = ?, attempts = 0,
      last_error = NULL WHERE id = ?`),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM events GROUP BY status'),
  };

  return {
    /** Guarda o evento; se a chave já existe, não duplica. */
    insert({ source, idempotencyKey, headers, body, now = Date.now() }) {
      const result = stmts.insert.run(source, idempotencyKey, JSON.stringify(headers), body, now, now);
      const id = Number(stmts.byKey.get(source, idempotencyKey).id);
      return { id, duplicate: result.changes === 0 };
    },
    get: (id) => row(stmts.get.get(id)),
    due: (now = Date.now(), limit = 10) => stmts.due.all(now, limit).map(row),
    markDelivered(id, now = Date.now()) {
      stmts.delivered.run(now, id);
    },
    /** nextAttemptAt = null marca como "dead" (desistiu). */
    markFailed(id, error, nextAttemptAt) {
      stmts.failed.run(String(error).slice(0, 1000), nextAttemptAt == null ? 1 : 0, nextAttemptAt ?? 0, id);
    },
    replay(id, now = Date.now()) {
      return stmts.replay.run(now, id).changes > 0;
    },
    list({ status, limit = 50 } = {}) {
      const sql = `SELECT * FROM events ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`;
      const args = status ? [status, Math.min(limit, 500)] : [Math.min(limit, 500)];
      return db.prepare(sql).all(...args).map(row);
    },
    counts() {
      const out = { pending: 0, delivered: 0, dead: 0 };
      for (const r of stmts.counts.all()) out[r.status] = Number(r.n);
      return out;
    },
    close: () => db.close(),
  };
}
