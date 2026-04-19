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
      message_id     TEXT,
      bot_id         TEXT NOT NULL,
      event_type     TEXT,
      raw_body       TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'received',
      receipt_id     TEXT,
      error_message  TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lw_inbox_status  ON lw_inbox(status);
    CREATE INDEX IF NOT EXISTS idx_lw_inbox_created ON lw_inbox(created_at);
  `);
  // Best-effort migration for pre-existing DBs (older Phase 2b schema without message_id).
  // Must run BEFORE creating idx_lw_inbox_message_id because the column may not exist yet.
  const cols = db
    .prepare("PRAGMA table_info('lw_inbox')")
    .all() as ReadonlyArray<{ name: string }>;
  if (!cols.some((c) => c.name === 'message_id')) {
    db.exec('ALTER TABLE lw_inbox ADD COLUMN message_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_lw_inbox_message_id ON lw_inbox(message_id)');
  // Phase 2c-fix-2: message_id wins idempotency when present. A partial unique
  // index on (bot_id, message_id) WHERE message_id IS NOT NULL makes retries
  // that reuse the same messageId (but vary the body) a no-op at INSERT OR
  // IGNORE time, without affecting rows where message_id is NULL.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS unique_lw_inbox_bot_message_id ' +
    'ON lw_inbox(bot_id, message_id) WHERE message_id IS NOT NULL',
  );
  return db;
}

export type InboxInsertArgs = {
  messageHash: string;
  messageId: string | null;
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
      '(message_hash, message_id, bot_id, event_type, raw_body, status, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const info = stmt.run(
      args.messageHash,
      args.messageId,
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
  message_id: string | null;
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

export type InboxStatus = 'received' | 'processing' | 'forwarded' | 'invalid' | 'failed';

/** FIFO list of rows currently in `received` status. */
export function listPendingInbox(limit: number, dbPath?: string): InboxRow[] {
  const db = openInboxDb(dbPath);
  try {
    return db
      .prepare(
        "SELECT * FROM lw_inbox WHERE status = 'received' ORDER BY created_at ASC LIMIT ?",
      )
      .all(limit) as InboxRow[];
  } finally {
    db.close();
  }
}

export type MarkStatusArgs = {
  messageHash: string;
  status: InboxStatus;
  errorMessage?: string | null;
  receiptId?: string | null;
};

/** Update status + optional error_message/receipt_id + updated_at. */
export function markInboxStatus(args: MarkStatusArgs, dbPath?: string): void {
  const db = openInboxDb(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE lw_inbox SET status = ?, error_message = ?, receipt_id = ?, updated_at = ? ' +
      'WHERE message_hash = ?',
    ).run(
      args.status,
      args.errorMessage ?? null,
      args.receiptId ?? null,
      now,
      args.messageHash,
    );
  } finally {
    db.close();
  }
}
