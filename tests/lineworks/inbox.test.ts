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

test('insertInbox creates schema and inserts new hash', () => {
  const dbPath = tempDbPath();
  const r = insertInbox(
    { messageHash: 'hash-aaa', botId: 'bot-1', eventType: 'message', rawBody: '{"k":1}' },
    dbPath,
  );
  assert.equal(r.inserted, true);
  assert.equal(r.messageHash, 'hash-aaa');

  const row = getInboxByHash('hash-aaa', dbPath);
  assert.ok(row);
  assert.equal(row!.bot_id, 'bot-1');
  assert.equal(row!.event_type, 'message');
  assert.equal(row!.status, 'received');
});

test('insertInbox is idempotent on duplicate hash', () => {
  const dbPath = tempDbPath();
  const args = { messageHash: 'dup-1', botId: 'bot-1', eventType: 'message', rawBody: '{}' };
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
    { messageHash: 'h', botId: 'b', eventType: 'message', rawBody: raw },
    dbPath,
  );
  const row = getInboxByHash('h', dbPath);
  assert.equal(row!.raw_body, raw);
});
