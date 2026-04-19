import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { insertInbox, getInboxByHash, openInboxDb } from '../../lib/lineworks/inbox';


function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-inbox-'));
  return path.join(dir, 'test.db');
}

test('insertInbox creates schema and inserts new hash with messageId', () => {
  const dbPath = tempDbPath();
  const r = insertInbox(
    {
      messageHash: 'hash-aaa',
      messageId: 'msg-01',
      botId: 'bot-1',
      eventType: 'message',
      rawBody: '{"k":1}',
    },
    dbPath,
  );
  assert.equal(r.inserted, true);
  assert.equal(r.messageHash, 'hash-aaa');

  const row = getInboxByHash('hash-aaa', dbPath);
  assert.ok(row);
  assert.equal(row!.bot_id, 'bot-1');
  assert.equal(row!.event_type, 'message');
  assert.equal(row!.status, 'received');
  assert.equal(row!.message_id, 'msg-01');
});

test('insertInbox accepts null messageId and stores null', () => {
  const dbPath = tempDbPath();
  insertInbox(
    {
      messageHash: 'no-id',
      messageId: null,
      botId: 'bot-1',
      eventType: 'message',
      rawBody: '{}',
    },
    dbPath,
  );
  const row = getInboxByHash('no-id', dbPath);
  assert.equal(row!.message_id, null);
});

test('insertInbox is idempotent on duplicate hash', () => {
  const dbPath = tempDbPath();
  const args = {
    messageHash: 'dup-1',
    messageId: 'msg-dup',
    botId: 'bot-1',
    eventType: 'message',
    rawBody: '{}',
  };
  const r1 = insertInbox(args, dbPath);
  const r2 = insertInbox(args, dbPath);
  assert.equal(r1.inserted, true);
  assert.equal(r2.inserted, false);
});

test('getInboxByHash returns null for unknown hash', () => {
  const dbPath = tempDbPath();
  openInboxDb(dbPath);
  assert.equal(getInboxByHash('does-not-exist', dbPath), null);
});

test('insertInbox preserves raw_body exactly', () => {
  const dbPath = tempDbPath();
  const raw = '{"type":"message","content":{"text":"こんにちは"}}';
  insertInbox(
    {
      messageHash: 'h',
      messageId: null,
      botId: 'b',
      eventType: 'message',
      rawBody: raw,
    },
    dbPath,
  );
  const row = getInboxByHash('h', dbPath);
  assert.equal(row!.raw_body, raw);
});

test('openInboxDb migrates legacy schema (adds message_id column)', () => {
  const dbPath = tempDbPath();
  // Create a legacy table WITHOUT message_id to simulate an existing Phase 2b DB.
  const Database = require('better-sqlite3');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE lw_inbox (
      message_hash TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      event_type TEXT,
      raw_body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      receipt_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy.close();

  // Opening with new code must ALTER the table to add message_id.
  const db = openInboxDb(dbPath);
  const cols = db.prepare("PRAGMA table_info('lw_inbox')").all() as { name: string }[];
  db.close();
  assert.ok(cols.some((c) => c.name === 'message_id'), 'message_id column should be added');

  // Inserts on the migrated DB work end-to-end.
  insertInbox(
    {
      messageHash: 'after-mig',
      messageId: 'msg-mig',
      botId: 'b',
      eventType: 'message',
      rawBody: '{}',
    },
    dbPath,
  );
  const row = getInboxByHash('after-mig', dbPath);
  assert.equal(row!.message_id, 'msg-mig');
});
