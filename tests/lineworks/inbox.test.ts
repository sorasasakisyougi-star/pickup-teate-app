import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  insertInbox,
  getInboxByHash,
  openInboxDb,
  listPendingInbox,
  markInboxStatus,
  claimInboxRow,
} from '../../lib/lineworks/inbox';


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

// Phase 2c-fix-2: message_id wins dedup even when raw_body (and therefore
// message_hash) differs between the retry and the first delivery.
test('insertInbox dedups on (bot_id, message_id) even when raw body differs', () => {
  const dbPath = tempDbPath();
  const r1 = insertInbox(
    {
      messageHash: 'hash-A',
      messageId: 'msg-same',
      botId: 'bot-1',
      eventType: 'message',
      rawBody: '{"v":1}',
    },
    dbPath,
  );
  const r2 = insertInbox(
    {
      messageHash: 'hash-B', // different body → different hash
      messageId: 'msg-same',
      botId: 'bot-1',
      eventType: 'message',
      rawBody: '{"v":2}',
    },
    dbPath,
  );
  assert.equal(r1.inserted, true);
  assert.equal(r2.inserted, false);
  // The stored row is the first one — second insert must not overwrite.
  const row = getInboxByHash('hash-A', dbPath);
  assert.equal(row!.raw_body, '{"v":1}');
  assert.equal(getInboxByHash('hash-B', dbPath), null);
});

test('insertInbox allows same message_id across different bots (scoped dedup)', () => {
  const dbPath = tempDbPath();
  const r1 = insertInbox(
    { messageHash: 'h1', messageId: 'shared', botId: 'bot-1', eventType: 'message', rawBody: '{}' },
    dbPath,
  );
  const r2 = insertInbox(
    { messageHash: 'h2', messageId: 'shared', botId: 'bot-2', eventType: 'message', rawBody: '{}' },
    dbPath,
  );
  assert.equal(r1.inserted, true);
  assert.equal(r2.inserted, true);
});

test('insertInbox does NOT collide when message_id is null (falls back to hash only)', () => {
  const dbPath = tempDbPath();
  const r1 = insertInbox(
    { messageHash: 'ha', messageId: null, botId: 'bot-1', eventType: 'message', rawBody: 'a' },
    dbPath,
  );
  const r2 = insertInbox(
    { messageHash: 'hb', messageId: null, botId: 'bot-1', eventType: 'message', rawBody: 'b' },
    dbPath,
  );
  assert.equal(r1.inserted, true);
  assert.equal(r2.inserted, true);
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

// --- listPendingInbox / markInboxStatus ------------------------------------

function smallSleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

test('listPendingInbox returns only status=received, ordered by created_at ASC', async () => {
  const dbPath = tempDbPath();
  // Insert 3 rows with deliberate gaps so created_at differs.
  insertInbox(
    { messageHash: 'h1', messageId: null, botId: 'b', eventType: 'message', rawBody: '{"k":1}' },
    dbPath,
  );
  await smallSleep(5);
  insertInbox(
    { messageHash: 'h2', messageId: null, botId: 'b', eventType: 'message', rawBody: '{"k":2}' },
    dbPath,
  );
  await smallSleep(5);
  insertInbox(
    { messageHash: 'h3', messageId: null, botId: 'b', eventType: 'message', rawBody: '{"k":3}' },
    dbPath,
  );

  // Flip one row to 'forwarded' — it must disappear from the pending list.
  markInboxStatus(
    { messageHash: 'h2', status: 'forwarded', receiptId: '200' },
    dbPath,
  );

  const pending = listPendingInbox(10, dbPath);
  assert.equal(pending.length, 2);
  assert.deepEqual(
    pending.map((r) => r.message_hash),
    ['h1', 'h3'],
  );
});

test('listPendingInbox respects limit', () => {
  const dbPath = tempDbPath();
  for (let i = 0; i < 5; i++) {
    insertInbox(
      { messageHash: `h${i}`, messageId: null, botId: 'b', eventType: 'message', rawBody: '{}' },
      dbPath,
    );
  }
  assert.equal(listPendingInbox(3, dbPath).length, 3);
  assert.equal(listPendingInbox(10, dbPath).length, 5);
});

test('markInboxStatus forwarded: sets status + receiptId + clears error', () => {
  const dbPath = tempDbPath();
  insertInbox(
    { messageHash: 'x', messageId: null, botId: 'b', eventType: 'message', rawBody: '{}' },
    dbPath,
  );
  markInboxStatus(
    { messageHash: 'x', status: 'forwarded', receiptId: '202' },
    dbPath,
  );
  const row = getInboxByHash('x', dbPath)!;
  assert.equal(row.status, 'forwarded');
  assert.equal(row.receipt_id, '202');
  assert.equal(row.error_message, null);
});

test('markInboxStatus invalid: sets status + errorMessage', () => {
  const dbPath = tempDbPath();
  insertInbox(
    { messageHash: 'y', messageId: null, botId: 'b', eventType: 'message', rawBody: '{}' },
    dbPath,
  );
  markInboxStatus(
    { messageHash: 'y', status: 'invalid', errorMessage: 'driver_not_registered' },
    dbPath,
  );
  const row = getInboxByHash('y', dbPath)!;
  assert.equal(row.status, 'invalid');
  assert.equal(row.error_message, 'driver_not_registered');
  assert.equal(row.receipt_id, null);
});

test('claimInboxRow transitions received → processing atomically (first wins)', () => {
  const dbPath = tempDbPath();
  insertInbox(
    { messageHash: 'claim-1', messageId: null, botId: 'b', eventType: 'message', rawBody: '{}' },
    dbPath,
  );
  assert.equal(claimInboxRow('claim-1', dbPath), true);
  // Second claim must fail because status is now 'processing', not 'received'.
  assert.equal(claimInboxRow('claim-1', dbPath), false);
  const row = getInboxByHash('claim-1', dbPath)!;
  assert.equal(row.status, 'processing');
});

test('claimInboxRow returns false for unknown hash', () => {
  const dbPath = tempDbPath();
  openInboxDb(dbPath);
  assert.equal(claimInboxRow('does-not-exist', dbPath), false);
});

test('claimInboxRow refuses to re-claim a forwarded row', () => {
  const dbPath = tempDbPath();
  insertInbox(
    { messageHash: 'c2', messageId: null, botId: 'b', eventType: 'message', rawBody: '{}' },
    dbPath,
  );
  markInboxStatus(
    { messageHash: 'c2', status: 'forwarded', receiptId: 'flow-xyz' },
    dbPath,
  );
  assert.equal(claimInboxRow('c2', dbPath), false);
});

test('markInboxStatus updates updated_at', async () => {
  const dbPath = tempDbPath();
  insertInbox(
    { messageHash: 'z', messageId: null, botId: 'b', eventType: 'message', rawBody: '{}' },
    dbPath,
  );
  const before = getInboxByHash('z', dbPath)!;
  await smallSleep(10);
  markInboxStatus({ messageHash: 'z', status: 'failed', errorMessage: 'http_502' }, dbPath);
  const after = getInboxByHash('z', dbPath)!;
  assert.ok(after.updated_at > before.updated_at, 'updated_at must advance');
});
