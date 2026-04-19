// SQLite-backed inbox for LINE WORKS webhook events.
// Dedup via message_hash. INSERT OR IGNORE makes retries no-ops.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function getInboxDbPath(): string {
  return (
    process.env.LW_INBOX_DB_PATH ||
    path.join(process.cwd(), '.data', 'lw_inbox.db')
  );
}

export function openInboxDb(dbPath?: string): Database.Database {
  const target = dbPath || getInboxDbPath();
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS lw_inbox (
      message_hash   TEXT PRIMARY KEY,
      bot_id         TEXT NOT NULL,
      event_type     TEXT,
      raw_body       TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'received',
      receipt_id     TEXT,
      error_message  TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lw_inbox_status ON lw_inbox(status);
    CREATE INDEX IF NOT EXISTS idx_lw_inbox_created ON lw_inbox(created_at);
  `);
  return db;
}

export type InboxInsertArgs = {
  messageHash: string;
  botId: string;
  eventType: string | null;
  rawBody: string;
};

export type InboxInsertResult = {
  inserted: boolean;
  messageHash: string;
};

export function insertInbox(
  args: InboxInsertArgs,
  dbPath?: string,
): InboxInsertResult {
  const db = openInboxDb(dbPath);
  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO lw_inbox ' +
      '(message_hash, bot_id, event_type, raw_body, status, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const info = stmt.run(
      args.messageHash,
      args.botId,
      args.eventType,
      args.rawBody,
      'received',
      now,
      now,
    );
    return { inserted: info.changes === 1, messageHash: args.messageHash };
  } finally {
    db.close();
  }
}

export type InboxRow = {
  message_hash: string;
  bot_id: string;
  event_type: string | null;
  raw_body: string;
  status: string;
  receipt_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export function getInboxByHash(hash: string, dbPath?: string): InboxRow | null {
  const db = openInboxDb(dbPath);
  try {
    const row = db
      .prepare('SELECT * FROM lw_inbox WHERE message_hash = ?')
      .get(hash) as InboxRow | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}
